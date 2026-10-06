import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

const fsLstat = promisify(fs.lstat);
const fsReadlink = promisify(fs.readlink);
const fsMkdir = promisify(fs.mkdir);

// Import the main window getter
import { getMainWindow } from './main';
import { findDayZExecutable } from './dayz-launcher';
import {
  createDirectoryLink,
  pathExists,
  existsOrLink,
  isSymlink,
  getSymlinkTarget,
  buildModLinkName,
  parseWorkshopIdFromLinkName,
  isLinux,
  resolveWorkshopRootForMod,
} from './platform-utils';

// Simple mod interface for server join - only needs workshopId and name
interface ServerMod {
  workshopId: number;
  name: string;
}

/**
 * What the download/verify phase learned, handed to the link and launch phases.
 *
 * `folders` is the important part: Steam's own answer for where each mod lives. The
 * launch path used to throw this away and re-derive the workshop root from the default
 * Steam install, which is wrong for anyone with a second Steam library.
 */
export interface ModVerificationResult {
  /** Parent of the mod folders, from Steam install info. */
  workshopRootPath: string;
  /** workshopId (as string) -> absolute install folder, straight from Steam. */
  folders: Record<string, string>;
  /** Mods we could not subscribe to, by name. */
  skipped: string[];
}

// Import steam client from steam service
import { getSteamClient, getModUpdateStatus, requestWorkshopDownload, ITEM_STATE, type ModUpdateStatus } from './steam-service';
import { e2eHooks } from './e2e-hooks';
import { beginJoinPhase, isJoinActive, runWhenNoJoinActive } from './join-phase';

// Cancellation flag
let isCancelled = false;

// Junction cache - tracks which junctions are already valid
const junctionCache = new Map<string, { targetPath: string; validatedAt: number }>();
const JUNCTION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Background junction task state
let isBackgroundJunctionRunning = false;

/**
 * Normalize a path for consistent comparison
 * Removes trailing separators, resolves to absolute, and normalizes separators
 */
function normalizeLinkPath(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '');
}

/**
 * Set the cancellation flag
 */
export function cancelDownloadProcess(): void {
  console.log('⚠️ Download process cancellation requested');
  isCancelled = true;
}

/**
 * Reset the cancellation flag
 */
export function resetCancellationFlag(): void {
  isCancelled = false;
}

/**
 * Check if the process has been cancelled
 */
export function isCancelRequested(): boolean {
  return isCancelled;
}

/**
 * Check if junction is valid from cache
 */
function isJunctionCached(linkPath: string, expectedTarget: string): boolean {
  const cached = junctionCache.get(linkPath);
  if (!cached) return false;

  const isExpired = Date.now() - cached.validatedAt > JUNCTION_CACHE_TTL;
  if (isExpired) {
    junctionCache.delete(linkPath);
    return false;
  }

  return normalizeLinkPath(cached.targetPath) === normalizeLinkPath(expectedTarget);
}

/**
 * Cache a valid junction
 */
function cacheJunction(linkPath: string, targetPath: string): void {
  junctionCache.set(linkPath, { targetPath: normalizeLinkPath(targetPath), validatedAt: Date.now() });
}

/** How long we will wait for one mod to finish downloading before giving up. */
const MOD_DOWNLOAD_TIMEOUT_MS = e2eHooks?.timing.modDownloadTimeoutMs ?? 10 * 60 * 1000;

/**
 * What "finished" means for one mod we are waiting on, captured before the download.
 *
 * Deliberately one shared type and one shared predicate: the join wait and the background
 * sweep both poll for completion, and when the sweep open-coded its own check it got this
 * wrong in exactly the way the join wait exists to prevent (see isFreshnessSettled).
 */
interface FreshnessTarget {
  /** Workshop version we are waiting for, or 0 when the flags alone are decisive. */
  requiredTimestamp: number;
  /** Install timestamp before the download, so we can tell that anything changed. */
  initialLocalTimestamp: number;
}

function freshnessTargetFor(status: ModUpdateStatus): FreshnessTarget {
  return {
    // Only a timestamp-detected staleness needs a target. When Steam's NeedsUpdate bit is
    // what flagged the mod, that bit clearing is itself proof the update landed.
    requiredTimestamp: status.reason === 'timestamp' ? status.workshopTimestamp : 0,
    initialLocalTimestamp: status.localTimestamp,
  };
}

/**
 * Has this mod actually reached the version we are waiting for?
 *
 * The trap: when staleness was found by comparing timestamps, Steam's NeedsUpdate flag is
 * NOT set — that is the entire reason the timestamp comparison exists. So a flag-only
 * poll reports `isUpToDate` on the first tick, before Steam has even started the
 * download, and the caller declares the mod updated while the old files are still on
 * disk. Requiring the install timestamp to move is what closes that window.
 */
function isFreshnessSettled(candidate: ModUpdateStatus, target: FreshnessTarget): boolean {
  if (!candidate.isUpToDate) return false;
  if (target.requiredTimestamp === 0) return true;
  // A metadata-only edit: Steam had nothing to download, so the install timestamp will
  // never move. The acknowledged version stands in for it (see mod-update-tracker).
  if (Math.max(candidate.localTimestamp, candidate.acknowledgedTimestamp) >= target.requiredTimestamp) return true;
  // Steam's install timestamp advanced, just not to the value we predicted. The files on
  // disk demonstrably changed and Steam reports nothing outstanding, so accept it rather
  // than wait out the deadline over a timestamp convention we do not control.
  return candidate.localTimestamp > target.initialLocalTimestamp;
}

/**
 * Wait until Steam reports this mod as installed AND current.
 *
 * The previous version resolved on `state & INSTALLED` alone. A mod that merely needs an
 * update is *already* installed, so the wait returned on the first tick, the launch went
 * ahead on the old files, and the server rejected the player for a mod version mismatch
 * — the exact symptom of "I updated and it still says my mods are wrong". Waiting on the
 * full freshness predicate is the fix.
 *
 * The state flags are polled every second; the workshop query behind the timestamp check
 * is not, because it is a network round trip. It runs on entry (via the caller's status
 * check) and then every REVALIDATE_EVERY ticks, which is enough to notice that Steam has
 * committed the new files while keeping the loop cheap.
 */
async function waitForModUpToDate(mod: ServerMod, initialStatus: ModUpdateStatus): Promise<ModUpdateStatus> {
  const win = getMainWindow();
  const workshopId = BigInt(mod.workshopId);
  const startedAt = Date.now();
  const REVALIDATE_EVERY = 5; // ticks between workshop queries

  const target = freshnessTargetFor(initialStatus);
  const isSettled = (candidate: ModUpdateStatus): boolean => isFreshnessSettled(candidate, target);

  let tick = 0;
  let status = initialStatus;
  let lastProgressLog = 0;

  while (!isSettled(status)) {
    if (isCancelRequested()) {
      throw new Error('Download cancelled by user');
    }

    if (Date.now() - startedAt > MOD_DOWNLOAD_TIMEOUT_MS) {
      throw new Error(`Download timeout for ${mod.name} after ${MOD_DOWNLOAD_TIMEOUT_MS / 60000} minutes`);
    }

    // Report byte progress so the UI moves during a long update
    try {
      const downloadInfo = getSteamClient().workshop.downloadInfo(workshopId);
      if (downloadInfo?.total > 0) {
        const progress = (Number(downloadInfo.current) / Number(downloadInfo.total)) * 100;
        win?.webContents.send('mod-download-progress', {
          modId: mod.workshopId,
          progress,
          current: downloadInfo.current,
          total: downloadInfo.total,
        });

        if (Date.now() - lastProgressLog > 15000) {
          console.log(`⬇️ ${mod.name}: ${progress.toFixed(1)}%`);
          lastProgressLog = Date.now();
        }
      }
    } catch {
      // downloadInfo is unavailable between the queue and the transfer — not fatal
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    tick++;

    status = await getModUpdateStatus(mod.workshopId.toString(), {
      queryWorkshop: tick % REVALIDATE_EVERY === 0,
    });

    // Steam sometimes drops a queued item without starting it (paused downloads, a
    // client that lost its queue). If nothing is in flight and it is still stale, ask
    // again rather than waiting out the full timeout on a download that will never come.
    const stalled = !status.isDownloading && !isSettled(status);
    if (stalled && tick % 10 === 0) {
      console.log(`🔄 ${mod.name} still stale and not downloading — re-triggering (state ${status.itemState})`);
      try {
        requestWorkshopDownload(workshopId, true);
      } catch (error) {
        console.warn(`Could not re-trigger download for ${mod.name}:`, (error as Error).message);
      }
    }
  }

  return status;
}

/**
 * Downloads and verifies mods for a server join operation.
 *
 * Returns Steam's own answer for where every mod lives, so the link and launch phases do
 * not have to guess at the workshop root (see ModVerificationResult).
 */
export async function downloadAndVerifyMods(mods: ServerMod[]): Promise<ModVerificationResult> {
  const win = getMainWindow();
  let workshopRootPath: string | null = null;
  const folders: Record<string, string> = {};
  const skippedMods: string[] = [];

  // Reset cancellation flag at start
  resetCancellationFlag();

  console.log(`Starting download/verification for ${mods.length} mods`);
  console.log('📦 Mod data received:', JSON.stringify(mods.slice(0, 2), null, 2)); // Log first 2 mods for debugging

  for (let i = 0; i < mods.length; i++) {
    // Check for cancellation
    if (isCancelRequested()) {
      console.log('⚠️ Download process cancelled by user');
      throw new Error('Download cancelled by user');
    }

    const mod = mods[i];

    // ServerMod always has workshopId
    if (!mod.workshopId) {
      console.error('❌ Mod missing workshop ID. Mod object:', JSON.stringify(mod, null, 2));
      throw new Error(`Mod "${mod.name || 'Unknown'}" is missing workshop ID. Check server mod data format.`);
    }

    const workshopId = BigInt(mod.workshopId);

    win?.webContents.send('mod-download-status', {
      status: `Checking mod ${i + 1}/${mods.length}: ${mod.name}`
    });

    let itemState = getSteamClient().workshop.state(workshopId);
    console.log(`Mod: ${mod.name} (${mod.workshopId}) - Initial State: ${itemState}`);

    // Subscribe if not subscribed
    if (!(itemState & ITEM_STATE.SUBSCRIBED)) {
      win?.webContents.send('mod-download-status', {
        status: `Subscribing to ${mod.name}...`
      });

      try {
        await getSteamClient().workshop.subscribe(workshopId);
        // Wait a moment for Steam to update the state
        await new Promise(resolve => setTimeout(resolve, 1000));
        itemState = getSteamClient().workshop.state(workshopId);

        // Check if subscription was successful
        if (!(itemState & ITEM_STATE.SUBSCRIBED)) {
          console.warn(`⚠️ Failed to subscribe to ${mod.name} - Steam API did not confirm subscription`);
          skippedMods.push(mod.name);
          win?.webContents.send('mod-download-status', {
            status: `Skipping ${mod.name} - subscription failed`
          });
          continue; // Skip this mod and continue with the rest
        }
      } catch (error: any) {
        console.error(`❌ Failed to subscribe to ${mod.name}:`, error);
        skippedMods.push(mod.name);
        win?.webContents.send('mod-download-status', {
          status: `Skipping ${mod.name} - ${error.message || 'subscription failed'}`
        });
        continue; // Skip this mod and continue with the rest
      }
    }

    // One freshness verdict, including the timestamp comparison the join path used to
    // skip. Relying on the NeedsUpdate bit alone missed every stale mod that the Steam
    // client had not re-checked yet.
    let status = await getModUpdateStatus(mod.workshopId.toString());
    console.log(`🔎 ${mod.name}: installed=${status.isInstalled} needsUpdate=${status.needsUpdate} downloading=${status.isDownloading} reason=${status.reason}`);

    if (!status.isUpToDate) {
      if (status.isDownloading) {
        win?.webContents.send('mod-download-status', {
          status: `Waiting for ${mod.name} download to complete...`
        });
      } else {
        const verb = status.needsUpdate ? 'Updating' : 'Downloading';
        win?.webContents.send('mod-download-status', {
          status: `${verb} ${mod.name}...`
        });
        requestWorkshopDownload(workshopId, true);
      }

      status = await waitForModUpToDate(mod, status);
      console.log(`✅ ${mod.name} is now current (timestamp ${status.localTimestamp})`);
    }

    if (!status.folder) {
      throw new Error(`Mod path not found for ${mod.name}. Install info returned no folder. Final state: ${status.itemState}`);
    }

    if (!fs.existsSync(status.folder)) {
      throw new Error(`Mod path not found for ${mod.name}. Path does not exist: ${status.folder}`);
    }

    folders[mod.workshopId.toString()] = status.folder;

    // Store the workshop root path (parent directory of the mod folder)
    if (!workshopRootPath) {
      workshopRootPath = path.dirname(status.folder);
      console.log(`✅ Workshop root path: ${workshopRootPath}`);
    }

    console.log(`✅ Verified mod path: ${status.folder}`);
  }

  if (!workshopRootPath) {
    throw new Error('Failed to determine workshop root path');
  }

  // Send completion status with summary
  const successCount = mods.length - skippedMods.length;
  let statusMessage = `${successCount}/${mods.length} mods verified successfully!`;

  if (skippedMods.length > 0) {
    console.warn(`⚠️ Skipped ${skippedMods.length} mods:`, skippedMods);
    statusMessage += ` (${skippedMods.length} skipped: ${skippedMods.join(', ')})`;
  }

  win?.webContents.send('mod-download-status', {
    status: statusMessage
  });

  return { workshopRootPath, folders, skipped: skippedMods };
}

// =============================================================================
// Windows junction naming
// =============================================================================

/**
 * Index the links already in !dzbl by the workshop id embedded in their name.
 *
 * This is why the readable half of a junction name does not have to match between the
 * two places that create links. Pre-warming names a mod from Steam's workshop title;
 * a join names it from the title the server reported, and those differ regularly (case,
 * punctuation, a truncated name in the server's own mod list). Under title-only naming
 * that meant pre-warming built a junction the join never used, then the join built a
 * second one — and `cleanupOrphanedLinks` removed neither, because both targets resolved.
 * Keying on the id instead lets either side adopt the link the other already made.
 */
async function readExistingModLinks(junctionDir: string): Promise<Map<string, string>> {
  const byWorkshopId = new Map<string, string>();

  try {
    const entries = await fs.promises.readdir(junctionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith('@')) continue;
      const workshopId = parseWorkshopIdFromLinkName(entry.name);
      if (workshopId) byWorkshopId.set(workshopId, entry.name);
    }
  } catch {
    // Directory missing or unreadable — callers fall back to a freshly built name
  }

  return byWorkshopId;
}

/**
 * The link name to use for one mod: whatever is already on disk for this workshop id,
 * otherwise a fresh readable name. One readdir serves a whole join, so pass `existing`
 * in rather than letting this re-scan per mod.
 */
function resolveModLinkName(
  mod: ServerMod,
  existing: Map<string, string>,
  fallbackName?: string
): string {
  const workshopId = mod.workshopId.toString();
  return existing.get(workshopId) || buildModLinkName(fallbackName || mod.name, workshopId);
}

/**
 * The `!dzbl` link name for every mod of a join, workshop id -> link name.
 *
 * Exported because the launch command and the junctions have to agree exactly: the
 * `-mod=` list names folders, and a name the game cannot find loads no mod at all,
 * without saying so. Callers must not rebuild these names themselves.
 */
export async function getWindowsModLinkNames(
  mods: ServerMod[],
  dayZExecutablePath: string
): Promise<Map<string, string>> {
  const junctionDir = path.join(path.dirname(dayZExecutablePath), '!dzbl');
  const existing = await readExistingModLinks(junctionDir);

  return new Map(mods.map(mod => [mod.workshopId.toString(), resolveModLinkName(mod, existing)]));
}

/**
 * Creates mod junctions for Day(Z) Beans Launcher
 * OPTIMIZED: Uses parallel junction creation and caching for speed
 */
export async function createModJunctions(
  verification: ModVerificationResult,
  mods: ServerMod[],
  dayZExecutablePath: string
): Promise<string> {
  const { workshopRootPath, folders } = verification;
    // Bail out if the join was cancelled during the download/verify phase — otherwise
    // we would create junctions and let the caller launch DayZ for a cancelled join.
    if (isCancelRequested()) {
      console.log('⚠️ Skipping junction creation — join cancelled by user');
      throw new Error('Join process cancelled');
    }

    const junctionDir = await ensureJunctionDirectory(dayZExecutablePath);

    // On Linux, launchDayZ creates its own @workshopId symlinks directly in the DayZ
    // root (see dayz-launcher.createWorkshopIdSymlinks). The !dzbl/@ModName links this
    // function would create are never referenced by the launch command and are never
    // cleaned by cleanupOrphanedLinks (which only scans the DayZ root on Linux), so they
    // would just accumulate. Skip creation entirely and let the launcher handle it.
    if (isLinux) {
      console.log('🐧 Linux: skipping !dzbl junction creation (launcher creates @workshopId symlinks)');
      return junctionDir;
    }

    console.log(`⚡ Creating junctions for ${mods.length} mods (parallel)...`);
    const startTime = Date.now();
  
    // Build list of junctions to create. One readdir for the whole batch: names are
    // resolved by workshop id, so a link pre-warming already created gets reused instead
    // of duplicated under a differently-spelled title.
    const existingLinks = await readExistingModLinks(junctionDir);
    const junctionsToCreate: Array<{ mod: ServerMod; sourcePath: string; linkPath: string; modName: string }> = [];
    const claimedLinkPaths = new Set<string>();

    for (const mod of mods) {
      // Steam's own install folder when we have it; the shared root is only a fallback
      // for a mod that was skipped during verification.
      const sourcePath = folders[mod.workshopId.toString()]
        || path.join(workshopRootPath, mod.workshopId.toString());
      const modName = resolveModLinkName(mod, existingLinks);
      const linkPath = path.join(junctionDir, modName);

      // Two required mods can no longer land on one link path (the id makes each name
      // unique), but a server listing the same mod twice still can — and these are
      // created in parallel batches, where two writers on one path race each other into
      // EEXIST/ENOENT.
      if (claimedLinkPaths.has(linkPath)) {
        continue;
      }
      claimedLinkPaths.add(linkPath);

      // Quick cache check - skip if already valid
      if (isJunctionCached(linkPath, sourcePath)) {
        continue;
      }

      junctionsToCreate.push({ mod, sourcePath, linkPath, modName });
    }
    
    if (junctionsToCreate.length === 0) {
      console.log(`⚡ All ${mods.length} junctions already cached, skipping creation`);
      return junctionDir;
    }
    
    console.log(`🔧 Need to create/verify ${junctionsToCreate.length} junctions`);
  
    // Create junctions in parallel batches (faster than sequential)
    const BATCH_SIZE = 10; // Create 10 junctions at a time
    
    for (let i = 0; i < junctionsToCreate.length; i += BATCH_SIZE) {
      const batch = junctionsToCreate.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async ({ sourcePath, linkPath, modName }) => {
        try {
          await createJunction(sourcePath, linkPath, modName);
        } catch (error) {
          console.warn(`⚠️ Failed to create junction for ${modName}:`, error);
          // Don't throw - continue with other junctions
        }
      }));
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`✅ Junction creation complete in ${elapsed}ms`);
  
    return junctionDir;
  }

/**
 * Creates a directory link (junction on Windows, symlink on Linux/Mac)
 * Uses platform-utils for cross-platform compatibility
 */
async function createJunction(sourcePath: string, linkPath: string, modName: string): Promise<void> {
  // Check cache first
  if (isJunctionCached(linkPath, sourcePath)) {
    console.log(`⚡ Link ${modName} valid from cache`);
    return;
  }

  // Verify source exists (async)
  if (!await pathExists(sourcePath)) {
    throw new Error(`Source mod path does not exist: ${sourcePath}`);
  }

  // Check if link already exists and is correct. existsOrLink, not pathExists: a link
  // whose target is gone still owns the name, and skipping the recreate below left it
  // broken for the rest of the session.
  if (await existsOrLink(linkPath)) {
    try {
      if (await isSymlink(linkPath)) {
        const currentTarget = await getSymlinkTarget(linkPath);
        if (currentTarget && normalizeLinkPath(currentTarget) === normalizeLinkPath(sourcePath)) {
          console.log(`⚡ Link ${modName} already exists and is correct`);
          cacheJunction(linkPath, sourcePath);
          return;
        }
        console.log(`🔄 Link ${modName} points to wrong target, recreating...`);
        // Wrong target - will be removed by createDirectoryLink
      }
    } catch {
      // Error checking, createDirectoryLink will handle cleanup
    }
  }

  try {
    // Use platform-specific link creation (junction on Windows, symlink on Linux)
    await createDirectoryLink(sourcePath, linkPath);
    
    // Cache the successful link
    cacheJunction(linkPath, sourcePath);
    console.log(`✅ Link created: ${modName}`);
  } catch (error: any) {
    console.error(`❌ Link creation failed for ${modName}:`, error);
    throw new Error(`Failed to create link for ${modName}: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Create a single junction for a mod (called immediately after download)
 * This is exported so it can be called from downloadAndVerifyMods
 */
export async function createSingleModJunction(
  mod: ServerMod, 
  workshopPath: string, 
  junctionDir: string
): Promise<void> {
  const modName = resolveModLinkName(mod, await readExistingModLinks(junctionDir));
  const linkPath = path.join(junctionDir, modName);

  // Link must point at the individual mod folder (workshopPath/<workshopId>), not the
  // whole workshop root.
  const sourcePath = path.join(workshopPath, mod.workshopId.toString());
  await createJunction(sourcePath, linkPath, modName);
}

/**
 * Links the non-Workshop mod folders of a server on this PC so the client can load them,
 * and returns the `-mod=` entries naming the links.
 *
 * The folders come from local-server-discovery.ts (the server's own -mod argument,
 * checked on disk), never from the renderer. Linux: `@dzbl_local_<name>` symlinks in the
 * DayZ folder, beside the `@<workshopId>` ones. Windows: junctions in `!dzbl-local`, kept
 * out of `!dzbl` because the startup cleanup retires links there that carry no workshop id.
 */
export async function linkLocalServerMods(
  folders: Array<{ linkName: string; path: string }>,
  dayZExecutablePath: string
): Promise<string[]> {
  const dayzRoot = path.dirname(dayZExecutablePath);
  const linkDir = isLinux ? dayzRoot : path.join(dayzRoot, '!dzbl-local');
  if (!isLinux && !await pathExists(linkDir)) {
    await fsMkdir(linkDir, { recursive: true });
  }
  const entries: string[] = [];
  for (const folder of folders) {
    await createJunction(folder.path, path.join(linkDir, folder.linkName), folder.linkName);
    entries.push(isLinux ? folder.linkName : `!dzbl-local\\${folder.linkName}`);
  }
  return entries;
}

/**
 * Ensure junction directory exists
 */
export async function ensureJunctionDirectory(dayZExecutablePath: string): Promise<string> {
  const dayzRoot = path.dirname(dayZExecutablePath);
  const junctionDir = path.join(dayzRoot, '!dzbl');
  
  if (!await pathExists(junctionDir)) {
    await fsMkdir(junctionDir, { recursive: true });
    console.log('Created junction directory:', junctionDir);
  }
  
  return junctionDir;
}

/**
 * Resolve the folder a mod's symlink must point at, most trustworthy source first.
 *
 * 1. The folder Steam reported during verification (`ModVerificationResult.folders`).
 * 2. Steam's live install info.
 * 3. A scan of every known Steam library (handles a second drive).
 * 4. The shared workshop root we were handed.
 *
 * Guessing at step 4 alone is what broke multi-library installs: the guessed path did
 * not exist, so the link was deleted as "wrong" and then never recreated.
 */
async function resolveModSourcePath(
  mod: ServerMod,
  workshopRootPath: string,
  folders?: Record<string, string>
): Promise<string | null> {
  const workshopId = mod.workshopId.toString();

  const fromVerification = folders?.[workshopId];
  if (fromVerification && await pathExists(fromVerification)) {
    return fromVerification;
  }

  try {
    const installInfo = getSteamClient().workshop.installInfo(BigInt(mod.workshopId));
    if (installInfo?.folder && await pathExists(installInfo.folder)) {
      return installInfo.folder;
    }
  } catch {
    // Steam unavailable — fall through to the disk scan
  }

  const libraryRoot = await resolveWorkshopRootForMod(workshopId);
  if (libraryRoot) {
    return path.join(libraryRoot, workshopId);
  }

  const fallback = path.join(workshopRootPath, workshopId);
  return (await pathExists(fallback)) ? fallback : null;
}

/**
 * Creates @workshopid symlinks directly in the DayZ folder (Linux only)
 * This is the approach used by dayz-ctl and dztui for Linux/Proton
 * DayZ expects symlinks like @2681811822 pointing to workshop content
 *
 * Two rules this function now respects that it did not before:
 *
 * - Resolve the source BEFORE removing anything. It used to unlink a link it judged
 *   "wrong" and only then discover the replacement source did not exist, leaving the mod
 *   with no link at all — so a player whose mods live in a second Steam library had their
 *   working links destroyed by the act of joining a server.
 * - Treat a dangling link as occupied (existsOrLink). fs.access follows the link, so a
 *   broken one read as absent, the repair branch was skipped, and symlink() then failed
 *   with EEXIST into a swallowed warning.
 */
export async function createWorkshopIdSymlinks(
  workshopRootPath: string,
  mods: ServerMod[],
  dayZExecutablePath: string,
  folders?: Record<string, string>
): Promise<{ linked: string[]; failed: string[] }> {
  const dayzRoot = path.dirname(dayZExecutablePath);
  const linked: string[] = [];
  const failed: string[] = [];

  console.log(`🔗 Creating @workshopid symlinks for ${mods.length} mods...`);
  const startTime = Date.now();

  for (const mod of mods) {
    const workshopId = mod.workshopId.toString();
    const linkPath = path.join(dayzRoot, `@${workshopId}`);

    const sourcePath = await resolveModSourcePath(mod, workshopRootPath, folders);

    if (!sourcePath) {
      // Leave whatever is already there alone: an existing link that still resolves is
      // strictly better than the nothing we would replace it with.
      console.warn(`⚠️ Workshop content not found for mod ${mod.name} (${workshopId}) in any Steam library`);
      failed.push(workshopId);
      continue;
    }

    if (await existsOrLink(linkPath)) {
      try {
        if (await isSymlink(linkPath)) {
          const currentTarget = await getSymlinkTarget(linkPath);
          if (currentTarget && normalizeLinkPath(currentTarget) === normalizeLinkPath(sourcePath)) {
            linked.push(workshopId);
            continue; // Already correct
          }
          console.log(`🔄 Symlink @${workshopId} points to wrong target, recreating...`);
          await fs.promises.unlink(linkPath);
        } else {
          // A real directory with the same name: someone installed this mod manually.
          // Respect it rather than deleting the player's files.
          console.log(`📁 @${workshopId} is a real directory, leaving it untouched`);
          linked.push(workshopId);
          continue;
        }
      } catch (error: any) {
        console.warn(`⚠️ Could not inspect @${workshopId}:`, error.message);
        try {
          await fs.promises.unlink(linkPath);
        } catch { /* creation below will report the real problem */ }
      }
    }

    try {
      await fs.promises.symlink(sourcePath, linkPath, 'dir');
      console.log(`✅ Created symlink: @${workshopId} -> ${sourcePath}`);
      linked.push(workshopId);
    } catch (error: any) {
      console.warn(`⚠️ Failed to create symlink for @${workshopId}:`, error.message);
      failed.push(workshopId);
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`✅ Workshop ID symlinks complete in ${elapsed}ms (${linked.length} ok, ${failed.length} failed)`);

  return { linked, failed };
}

/**
 * Confirm every mod the game is about to be told to load actually resolves on disk.
 *
 * On Linux that means the `@workshopId` link in the DayZ root; on Windows the
 * `!dzbl/@ModName` junction. Called immediately before spawn, so a link that was deleted,
 * broken by a Steam library move, or never created cannot reach the game as a silently
 * missing mod — DayZ's own failure mode for that is an opaque rejection at connect time.
 */
export async function verifyModLinks(
  mods: ServerMod[],
  dayZExecutablePath: string
): Promise<{ ok: boolean; broken: Array<{ workshopId: string; name: string; linkPath: string }> }> {
  const dayzRoot = path.dirname(dayZExecutablePath);
  const broken: Array<{ workshopId: string; name: string; linkPath: string }> = [];

  // Windows link names are resolved from disk by workshop id, never rebuilt here — the
  // gate has to check the same folder the -mod= list names.
  const windowsLinkNames = isLinux
    ? new Map<string, string>()
    : await getWindowsModLinkNames(mods, dayZExecutablePath);

  for (const mod of mods) {
    const workshopId = mod.workshopId.toString();
    const linkPath = isLinux
      ? path.join(dayzRoot, `@${workshopId}`)
      : path.join(dayzRoot, '!dzbl', windowsLinkNames.get(workshopId) || buildModLinkName(mod.name, workshopId));

    // pathExists is correct here: we want to know the link RESOLVES, not that the name
    // is taken. A dangling link is exactly the failure we are looking for.
    if (!await pathExists(linkPath)) {
      broken.push({ workshopId, name: mod.name, linkPath });
    }
  }

  return { ok: broken.length === 0, broken };
}

/**
 * BUG-002: Cleanup orphaned symlinks/junctions from unsubscribed mods
 * Scans link directories and removes links whose targets no longer exist.
 *
 * On Windows: Scans !dzbl/ directory for broken junctions
 * On Linux: Scans DayZ root for broken @workshopid symlinks
 *
 * Runs async at startup before preWarmJunctions.
 */
export async function cleanupOrphanedLinks(): Promise<void> {
  console.log('🧹 Starting orphaned link cleanup...');

  try {
    const dayZExecutablePath = await findDayZExecutable();
    if (!dayZExecutablePath) return;

    const dayzRoot = path.dirname(dayZExecutablePath);
    const { isLinux } = await import('./platform-utils');

    let cleaned = 0;
    let checked = 0;

    if (isLinux) {
      // Linux: Check @workshopid symlinks in DayZ root
      const entries = await fs.promises.readdir(dayzRoot, { withFileTypes: true });
      for (const entry of entries) {
        // Only check @-prefixed entries (mod symlinks)
        if (!entry.name.startsWith('@')) continue;
        const linkPath = path.join(dayzRoot, entry.name);
        checked++;

        try {
          const stats = await fsLstat(linkPath);
          if (stats.isSymbolicLink()) {
            const target = await fsReadlink(linkPath);
            if (!await pathExists(target)) {
              console.log(`🧹 Removing broken symlink: ${entry.name} -> ${target}`);
              await fs.promises.unlink(linkPath);
              cleaned++;
            }
          }
        } catch {
          // If we can't stat or read the link, it's broken — remove it
          try {
            await fs.promises.unlink(linkPath);
            cleaned++;
          } catch { /* ignore */ }
        }
      }
    } else {
      // Windows: Check junctions in !dzbl/ directory
      const junctionDir = path.join(dayzRoot, '!dzbl');
      if (!await pathExists(junctionDir)) return;

      // Links whose name carries no workshop id come from the old title-only scheme.
      // Their targets still resolve, so the broken-link sweep below would keep them
      // forever, and nothing references them any more — the launch command now names
      // "@<title>_<id>". Retire them here or !dzbl grows a second copy of every mod.
      const entries = await fs.promises.readdir(junctionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.startsWith('@')) continue;
        const linkPath = path.join(junctionDir, entry.name);
        checked++;

        if (!parseWorkshopIdFromLinkName(entry.name)) {
          try {
            const stats = await fsLstat(linkPath);
            // Only ever remove a link. A real directory in here is a player's own file,
            // not something this launcher created.
            if (stats.isSymbolicLink()) {
              console.log(`🧹 Removing legacy title-only junction: ${entry.name}`);
              await fs.promises.unlink(linkPath);
              cleaned++;
              junctionCache.delete(linkPath);
              continue;
            }
          } catch {
            // Unreadable — fall through to the broken-link handling below
          }
        }

        try {
          const stats = await fsLstat(linkPath);
          if (stats.isSymbolicLink() || stats.isDirectory()) {
            // For junctions, check if the target directory is accessible
            if (stats.isSymbolicLink()) {
              const target = await fsReadlink(linkPath);
              if (!await pathExists(target)) {
                console.log(`🧹 Removing broken junction: ${entry.name} -> ${target}`);
                await fs.promises.unlink(linkPath);
                cleaned++;
                junctionCache.delete(linkPath);
              }
            } else {
              // Directory junction on Windows — try to read it
              try {
                await fs.promises.readdir(linkPath);
              } catch {
                console.log(`🧹 Removing inaccessible junction: ${entry.name}`);
                fs.rmSync(linkPath, { recursive: true, force: true });
                cleaned++;
                junctionCache.delete(linkPath);
              }
            }
          }
        } catch {
          try {
            fs.rmSync(linkPath, { recursive: true, force: true });
            cleaned++;
            junctionCache.delete(linkPath);
          } catch { /* ignore */ }
        }
      }
    }

    console.log(`🧹 Orphaned link cleanup done: checked ${checked}, removed ${cleaned}`);
  } catch (error) {
    console.error('🧹 Orphaned link cleanup failed:', error);
  }
}

/**
 * Background task: Pre-warm junctions for all subscribed mods
 * Runs on startup to ensure junctions exist before user tries to join a server
 * This runs with low priority and yields to the event loop frequently
 *
 * On Linux: Creates @workshopid symlinks directly in DayZ folder
 * On Windows: Creates @modname junctions in !dzbl folder
 */
export async function preWarmJunctions(): Promise<void> {
  if (isBackgroundJunctionRunning) {
    console.log('⏳ Background junction task already running, skipping...');
    return;
  }
  
  isBackgroundJunctionRunning = true;
  console.log('🔥 Starting background junction pre-warming...');

  // Clear junction cache on startup to force fresh verification
  junctionCache.clear();
  
  try {
    const dayZExecutablePath = await findDayZExecutable();
    if (!dayZExecutablePath) {
      console.log('⚠️ DayZ not found, skipping junction pre-warming');
      return;
    }
    
    const dayzRoot = path.dirname(dayZExecutablePath);
    const junctionDir = await ensureJunctionDirectory(dayZExecutablePath);
    
    // Get Steam client
    const { getSteamClient, isSteamInitialized } = await import('./steam-service');
    if (!isSteamInitialized()) {
      console.log('⚠️ Steam not initialized, skipping junction pre-warming');
      return;
    }
    
    // Check if we're on Linux
    const { isLinux } = await import('./platform-utils');
    
    const steamClient = getSteamClient();
    const subscribedItems = steamClient.workshop.getSubscribedItems();
    
    if (!subscribedItems || subscribedItems.length === 0) {
      console.log('📦 No subscribed mods found');
      return;
    }
    
    console.log(`📦 Found ${subscribedItems.length} subscribed mods, checking junctions...`);

    // Windows link names carry the workshop id; index what is already there so this pass
    // adopts existing links instead of creating parallel ones under its own spelling.
    const existingWindowsLinks = isLinux
      ? new Map<string, string>()
      : await readExistingModLinks(junctionDir);

    let created = 0;
    let skipped = 0;
    let failed = 0;
    
    // Process mods in small batches to avoid blocking
    const BATCH_SIZE = 5;
    
    for (let i = 0; i < subscribedItems.length; i += BATCH_SIZE) {
      const batch = subscribedItems.slice(i, i + BATCH_SIZE);
      
      // Process batch in parallel
      await Promise.all(batch.map(async (workshopId: bigint) => {
        try {
          const state = steamClient.workshop.state(workshopId);
          const isInstalled = !!(state & 4);
          
          if (!isInstalled) {
            skipped++;
            return;
          }
          
          const installInfo = steamClient.workshop.installInfo(workshopId);
          if (!installInfo?.folder || !await pathExists(installInfo.folder)) {
            skipped++;
            return;
          }
          
          // On Linux: Create @workshopid symlinks directly in DayZ folder 
          // On Windows: Create @modname junctions in !dzbl folder
          if (isLinux) {
            const linkPath = path.join(dayzRoot, `@${workshopId}`);

            // existsOrLink: a dangling link still owns the name, and the old
            // fs.access check read it as absent — so the repair was skipped and the
            // symlink() below failed with EEXIST.
            if (await existsOrLink(linkPath)) {
              try {
                if (await isSymlink(linkPath)) {
                  const currentTarget = await getSymlinkTarget(linkPath);
                  if (currentTarget && normalizeLinkPath(currentTarget) === normalizeLinkPath(installInfo.folder)) {
                    skipped++;
                    return;
                  }
                  console.log(`🔄 Symlink @${workshopId} points to wrong target, recreating...`);
                  await fs.promises.unlink(linkPath);
                } else {
                  // A real directory: a manually installed copy of this mod. Not ours.
                  skipped++;
                  return;
                }
              } catch {
                // Error checking, try to create anyway
              }
            }
            
            await fs.promises.symlink(installInfo.folder, linkPath, 'dir');
            created++;
          } else {
            // Windows: readable title plus the workshop id, in the !dzbl folder. Reuse
            // whatever link already carries this id rather than adding a second one
            // under Steam's spelling of the title.
            const details = await steamClient.workshop.getItem(workshopId);
            const sanitizedName = resolveModLinkName(
              { workshopId: Number(workshopId), name: details?.title || `Mod ${workshopId}` },
              existingWindowsLinks
            );
            const linkPath = path.join(junctionDir, sanitizedName);

            // Check if junction already exists and points to correct target
            if (await existsOrLink(linkPath)) {
              try {
                if (await isSymlink(linkPath)) {
                  const currentTarget = await getSymlinkTarget(linkPath);
                  if (currentTarget && normalizeLinkPath(currentTarget) === normalizeLinkPath(installInfo.folder)) {
                    cacheJunction(linkPath, installInfo.folder);
                    skipped++;
                    return;
                  }
                  console.log(`🔄 Junction ${sanitizedName} points to wrong target, recreating...`);
                }
              } catch {
                // Error checking, createJunction will handle it
              }
            }

            await createJunction(installInfo.folder, linkPath, sanitizedName);
            created++;
          }
        } catch (error) {
          failed++;
          // Don't log individual failures to avoid spam
        }
      }));
      
      // Yield to event loop between batches (keeps UI responsive)
      await new Promise(resolve => setImmediate(resolve));
    }
    
    console.log(`✅ Junction pre-warming complete: ${created} created, ${skipped} skipped, ${failed} failed`);
  } catch (error) {
    console.error('❌ Junction pre-warming failed:', error);
  } finally {
    isBackgroundJunctionRunning = false;
  }
}

// =============================================================================
// Background mod update sweep
// =============================================================================

// A join owns the Steam download queue while it runs; the sweep steps aside and picks up
// again once the last join has ended (see join-phase).
export { beginJoinPhase };

/** Pause between the last join ending and the sweep starting over. */
const SWEEP_RESUME_DELAY_MS = 5000;

let isUpdateSweepRunning = false;

export interface ModUpdateSweepResult {
  ran: boolean;
  checked: number;
  stale: number;
  completed: number;
  stillPending: number;
  reason?: string;
}

/** Progress pushed to the renderer as `mod-update-sweep`. */
interface SweepProgress {
  phase: 'checking' | 'updating' | 'done' | 'skipped';
  checked?: number;
  total?: number;
  stale?: number;
  completed?: number;
  names?: string[];
  error?: string;
}

function sendSweepProgress(progress: SweepProgress): void {
  getMainWindow()?.webContents.send('mod-update-sweep', progress);
}

/** Fallback for a mod the batched workshop query did not cover. */
async function getModTitle(workshopId: bigint): Promise<string> {
  try {
    const details = await getSteamClient().workshop.getItem(workshopId);
    return details?.title || `Mod ${workshopId}`;
  } catch {
    return `Mod ${workshopId}`;
  }
}

/**
 * Check every subscribed mod for an update and see the updates through.
 *
 * Runs at startup (and on demand from the Mods page) so a player who has not opened the
 * launcher in a week is current before they pick a server, instead of discovering it as
 * a rejected connection. Until this existed, the only update check in the product was a
 * button on the Mods page that iterated the *filtered* list — an active search silently
 * excluded mods — and merely asked Steam to start a download without ever confirming it
 * finished.
 *
 * Non-blocking by design: the caller does not await it at startup. It yields between
 * batches, defers to an active join (and starts over once the join is done), and reports
 * through `mod-update-sweep`.
 */
export async function sweepModUpdates(): Promise<ModUpdateSweepResult> {
  if (isUpdateSweepRunning) {
    return { ran: false, checked: 0, stale: 0, completed: 0, stillPending: 0, reason: 'already-running' };
  }

  isUpdateSweepRunning = true;
  const started = Date.now();
  let yieldedToJoin = false;

  try {
    const { isSteamInitialized } = await import('./steam-service');
    if (!isSteamInitialized()) {
      sendSweepProgress({ phase: 'skipped', error: 'Steam not initialized' });
      return { ran: false, checked: 0, stale: 0, completed: 0, stillPending: 0, reason: 'steam-unavailable' };
    }

    const subscribedItems: bigint[] = getSteamClient().workshop.getSubscribedItems() || [];
    if (subscribedItems.length === 0) {
      sendSweepProgress({ phase: 'done', checked: 0, total: 0, stale: 0, completed: 0 });
      return { ran: true, checked: 0, stale: 0, completed: 0, stillPending: 0 };
    }

    console.log(`🔄 Update sweep: checking ${subscribedItems.length} subscribed mods...`);
    sendSweepProgress({ phase: 'checking', checked: 0, total: subscribedItems.length });

    const { getModUpdateStatuses, fetchWorkshopItems } = await import('./steam-service');

    const BATCH_SIZE = 10;
    const stale: Array<{ workshopId: bigint; name: string; target: FreshnessTarget }> = [];
    let checked = 0;

    for (let i = 0; i < subscribedItems.length; i += BATCH_SIZE) {
      if (isJoinActive()) {
        console.log('⏸️ Update sweep yielding to an active join');
        sendSweepProgress({ phase: 'skipped', error: 'Paused for server join' });
        yieldedToJoin = true;
        return { ran: true, checked, stale: stale.length, completed: 0, stillPending: stale.length, reason: 'join-active' };
      }

      const batch = subscribedItems.slice(i, i + BATCH_SIZE).map(id => id.toString());
      // One batched UGC query for the batch's timestamps and titles, not one per mod
      const workshopItems = await fetchWorkshopItems(batch);
      const statuses = await getModUpdateStatuses(batch, { workshopItems });

      for (const status of statuses) {
        checked++;
        // Only chase mods that are installed and stale. A subscribed-but-never-installed
        // mod is not this sweep's business: the player may never join a server needing it,
        // and downloading it unasked would burn their bandwidth.
        if (status.isInstalled && status.needsUpdate) {
          stale.push({
            workshopId: BigInt(status.workshopId),
            name: workshopItems.get(status.workshopId)?.title || await getModTitle(BigInt(status.workshopId)),
            // Captured now, while we still have the workshop timestamp from the check
            // above. Without it the completion poll below cannot tell a finished update
            // from one Steam has not started yet.
            target: freshnessTargetFor(status),
          });
        }
      }

      sendSweepProgress({ phase: 'checking', checked, total: subscribedItems.length, stale: stale.length });

      // Yield so the UI stays responsive
      await new Promise(resolve => setImmediate(resolve));
    }

    if (stale.length === 0) {
      console.log(`✅ Update sweep: all ${checked} mods current (${Date.now() - started}ms)`);
      sendSweepProgress({ phase: 'done', checked, total: subscribedItems.length, stale: 0, completed: 0 });
      return { ran: true, checked, stale: 0, completed: 0, stillPending: 0 };
    }

    console.log(`📥 Update sweep: ${stale.length} mods need updating:`, stale.map(m => m.name));
    sendSweepProgress({
      phase: 'updating',
      checked,
      total: subscribedItems.length,
      stale: stale.length,
      completed: 0,
      names: stale.map(m => m.name),
    });

    for (const mod of stale) {
      try {
        requestWorkshopDownload(mod.workshopId, false); // background priority
      } catch (error) {
        console.warn(`⚠️ Could not start update for ${mod.name}:`, (error as Error).message);
      }
    }

    // See the downloads through rather than declaring victory on a triggered download.
    // Polls flags only (queryWorkshop: false) — one network round trip per mod every five
    // seconds for half an hour is not acceptable, and the version each mod must reach was
    // already captured in its FreshnessTarget.
    const DEADLINE_MS = 30 * 60 * 1000;
    const pending = new Map(stale.map(m => [m.workshopId.toString(), m]));
    let completed = 0;
    let poll = 0;

    while (pending.size > 0 && Date.now() - started < DEADLINE_MS) {
      if (isJoinActive()) {
        console.log('⏸️ Update sweep stops monitoring — join took over');
        yieldedToJoin = true;
        break;
      }

      await new Promise(resolve => setTimeout(resolve, e2eHooks?.timing.sweepPollMs ?? 5000));
      poll++;

      for (const [workshopId, mod] of [...pending.entries()]) {
        const status = await getModUpdateStatus(workshopId, { queryWorkshop: false });
        if (isFreshnessSettled(status, mod.target)) {
          console.log(`✅ Update sweep: ${mod.name} is now current`);
          pending.delete(workshopId);
          completed++;
          sendSweepProgress({
            phase: 'updating',
            checked,
            total: subscribedItems.length,
            stale: stale.length,
            completed,
          });
        } else if (!status.isDownloading && poll % 2 === 0) {
          // Re-ask every other poll, like the join wait: Steam can drop a queued item, and
          // a metadata-only edit is only called one once a re-request also went unanswered
          // (see mod-update-tracker).
          try {
            requestWorkshopDownload(mod.workshopId, false);
          } catch (error) {
            console.warn(`⚠️ Could not re-trigger update for ${mod.name}:`, (error as Error).message);
          }
        }
      }
    }

    // Links point at a path, and Steam updates a workshop item in place, so an update
    // does not normally invalidate them. It does when Steam relocates the item to
    // another library, so re-assert them once the dust settles.
    if (completed > 0) {
      await preWarmJunctions();
    }

    console.log(`🔄 Update sweep finished in ${Math.round((Date.now() - started) / 1000)}s: ${completed}/${stale.length} updated`);
    sendSweepProgress({
      phase: 'done',
      checked,
      total: subscribedItems.length,
      stale: stale.length,
      completed,
      names: [...pending.values()].map(mod => mod.name),
    });

    return { ran: true, checked, stale: stale.length, completed, stillPending: pending.size };
  } catch (error) {
    console.error('❌ Update sweep failed:', error);
    sendSweepProgress({ phase: 'done', error: (error as Error).message });
    return { ran: false, checked: 0, stale: 0, completed: 0, stillPending: 0, reason: (error as Error).message };
  } finally {
    isUpdateSweepRunning = false;
    // A join interrupted this sweep: start over once no join holds the queue, or the
    // remaining mods wait for the next launch.
    if (yieldedToJoin) {
      runWhenNoJoinActive(() => {
        setTimeout(() => { void sweepModUpdates(); }, SWEEP_RESUME_DELAY_MS);
      });
    }
  }
}
