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
  isSymlink,
  getSymlinkTarget,
  sanitizeModName,
  isLinux,
} from './platform-utils';

// Simple mod interface for server join - only needs workshopId and name
interface ServerMod {
  workshopId: number;
  name: string;
}

// Import steam client from steam service
import { getSteamClient } from './steam-service';

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

/**
 * Downloads and verifies mods for a server join operation
 * Returns the root workshop folder path where all mods are installed
 */
export async function downloadAndVerifyMods(mods: ServerMod[]): Promise<string> {
  const win = getMainWindow();
  let workshopRootPath: string | null = null;
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
    if (!(itemState & 1)) {
      win?.webContents.send('mod-download-status', {
        status: `Subscribing to ${mod.name}...`
      });
      
      try {
        await getSteamClient().workshop.subscribe(workshopId);
        // Wait a moment for Steam to update the state
        await new Promise(resolve => setTimeout(resolve, 1000));
        itemState = getSteamClient().workshop.state(workshopId);
        
        // Check if subscription was successful
        if (!(itemState & 1)) {
          console.warn(`⚠️ Failed to subscribe to ${mod.name} - Steam API did not confirm subscription`);
          skippedMods.push(mod.name);
          win?.webContents.send('mod-download-status', {
            status: `⚠️ Skipping ${mod.name} - subscription failed`
          });
          continue; // Skip this mod and continue with the rest
        }
      } catch (error: any) {
        console.error(`❌ Failed to subscribe to ${mod.name}:`, error);
        skippedMods.push(mod.name);
        win?.webContents.send('mod-download-status', {
          status: `⚠️ Skipping ${mod.name} - ${error.message || 'subscription failed'}`
        });
        continue; // Skip this mod and continue with the rest
      }
    }

    const isInstalled = !!(itemState & 4);
    const needsUpdate = !!(itemState & 8);
    const isDownloading = !!(itemState & 16);

    // Download if needed or wait for ongoing download
    if (!isInstalled || needsUpdate || isDownloading) {
      if (!isDownloading) {
        win?.webContents.send('mod-download-status', {
          status: `Downloading ${mod.name}...`
        });
        getSteamClient().workshop.download(workshopId, true);
      } else {
        win?.webContents.send('mod-download-status', {
          status: `Waiting for ${mod.name} download to complete...`
        });
      }

      // Wait for download to complete with timeout
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(interval);
          reject(new Error(`Download timeout for ${mod.name} after 10 minutes`));
        }, 600000); // 10 minute timeout

        const interval = setInterval(() => {
          // Check for cancellation
          if (isCancelRequested()) {
            clearInterval(interval);
            clearTimeout(timeout);
            reject(new Error('Download cancelled by user'));
            return;
          }

          const currentState = getSteamClient().workshop.state(workshopId);
          const downloadInfo = getSteamClient().workshop.downloadInfo(workshopId);
          
          if (downloadInfo?.total > 0) {
            const progress = (Number(downloadInfo.current) / Number(downloadInfo.total)) * 100;
            win?.webContents.send('mod-download-progress', {
              modId: mod.workshopId,
              progress,
              current: downloadInfo.current,
              total: downloadInfo.total
            });
          }

          // Check if installed (bit 2)
          if (currentState & 4) {
            clearInterval(interval);
            clearTimeout(timeout);
            resolve();
          }
        }, 1000);
      });
    }

    // Get and verify mod path
    const installInfo = getSteamClient().workshop.installInfo(workshopId);
    console.log(`Install info for ${mod.name}:`, installInfo);
    
    if (!installInfo?.folder) {
      const finalState = getSteamClient().workshop.state(workshopId);
      throw new Error(`Mod path not found for ${mod.name}. Install info returned no folder. Final state: ${finalState}`);
    }
    
    if (!fs.existsSync(installInfo.folder)) {
      throw new Error(`Mod path not found for ${mod.name}. Path does not exist: ${installInfo.folder}`);
    }

    // Store the workshop root path (parent directory of the mod folder)
    if (!workshopRootPath) {
      workshopRootPath = path.dirname(installInfo.folder);
      console.log(`✅ Workshop root path: ${workshopRootPath}`);
    }

    console.log(`✅ Verified mod path: ${installInfo.folder}`);
  }

  if (!workshopRootPath) {
    throw new Error('Failed to determine workshop root path');
  }

  // Send completion status with summary
  const successCount = mods.length - skippedMods.length;
  let statusMessage = `✅ ${successCount}/${mods.length} mods verified successfully!`;
  
  if (skippedMods.length > 0) {
    console.warn(`⚠️ Skipped ${skippedMods.length} mods:`, skippedMods);
    statusMessage += ` (${skippedMods.length} skipped: ${skippedMods.join(', ')})`;
  }

  win?.webContents.send('mod-download-status', {
    status: statusMessage
  });

  return workshopRootPath;
}

/**
 * Creates mod junctions for Day(Z) Beans Launcher
 * OPTIMIZED: Uses parallel junction creation and caching for speed
 */
export async function createModJunctions(workshopRootPath: string, mods: ServerMod[], dayZExecutablePath: string): Promise<string> {
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
  
    // Build list of junctions to create
    const junctionsToCreate: Array<{ mod: ServerMod; sourcePath: string; linkPath: string }> = [];
    
    for (const mod of mods) {
      const sourcePath = path.join(workshopRootPath, mod.workshopId.toString());
      const sanitizedModName = sanitizeModName(mod.name);
      const modName = `@${sanitizedModName}`;
      const linkPath = path.join(junctionDir, modName);
      
      // Quick cache check - skip if already valid
      if (isJunctionCached(linkPath, sourcePath)) {
        continue;
      }
      
      junctionsToCreate.push({ mod, sourcePath, linkPath });
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
      
      await Promise.all(batch.map(async ({ mod, sourcePath, linkPath }) => {
        const modName = `@${sanitizeModName(mod.name)}`;
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

  // Check if link already exists and is correct
  if (await pathExists(linkPath)) {
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
  const sanitizedModName = sanitizeModName(mod.name);
  const modName = `@${sanitizedModName}`;
  const linkPath = path.join(junctionDir, modName);

  // Link must point at the individual mod folder (workshopPath/<workshopId>), not the
  // whole workshop root.
  const sourcePath = path.join(workshopPath, mod.workshopId.toString());
  await createJunction(sourcePath, linkPath, modName);
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
 * Creates @workshopid symlinks directly in the DayZ folder (Linux only)
 * This is the approach used by dayz-ctl and dztui for Linux/Proton
 * DayZ expects symlinks like @2681811822 pointing to workshop content
 */
export async function createWorkshopIdSymlinks(
  workshopRootPath: string, 
  mods: ServerMod[], 
  dayZExecutablePath: string
): Promise<void> {
  const dayzRoot = path.dirname(dayZExecutablePath);
  
  console.log(`🔗 Creating @workshopid symlinks for ${mods.length} mods...`);
  const startTime = Date.now();
  
  for (const mod of mods) {
    const workshopId = mod.workshopId.toString();
    const sourcePath = path.join(workshopRootPath, workshopId);
    const linkPath = path.join(dayzRoot, `@${workshopId}`);
    
    // Check if link already exists and is correct
    if (await pathExists(linkPath)) {
      try {
        if (await isSymlink(linkPath)) {
          const currentTarget = await getSymlinkTarget(linkPath);
          if (currentTarget && normalizeLinkPath(currentTarget) === normalizeLinkPath(sourcePath)) {
            continue; // Already correct
          }
          console.log(`🔄 Symlink @${workshopId} points to wrong target, recreating...`);
        }
        // Remove incorrect link or non-symlink
        await fs.promises.unlink(linkPath);
      } catch {
        // Error checking, try to create anyway
      }
    }
    
    // Verify source exists
    if (!await pathExists(sourcePath)) {
      console.warn(`⚠️ Workshop content not found for mod ${mod.name}: ${sourcePath}`);
      continue;
    }
    
    try {
      await fs.promises.symlink(sourcePath, linkPath, 'dir');
      console.log(`✅ Created symlink: @${workshopId} -> ${sourcePath}`);
    } catch (error: any) {
      console.warn(`⚠️ Failed to create symlink for @${workshopId}:`, error.message);
    }
  }
  
  const elapsed = Date.now() - startTime;
  console.log(`✅ Workshop ID symlinks complete in ${elapsed}ms`);
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

      const entries = await fs.promises.readdir(junctionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.startsWith('@')) continue;
        const linkPath = path.join(junctionDir, entry.name);
        checked++;

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

            // Check if symlink already exists and is correct
            if (await pathExists(linkPath)) {
              try {
                if (await isSymlink(linkPath)) {
                  const currentTarget = await getSymlinkTarget(linkPath);
                  if (currentTarget && normalizeLinkPath(currentTarget) === normalizeLinkPath(installInfo.folder)) {
                    skipped++;
                    return;
                  }
                  console.log(`🔄 Symlink @${workshopId} points to wrong target, recreating...`);
                }
                // Remove incorrect link or non-symlink
                await fs.promises.unlink(linkPath);
              } catch {
                // Error checking, try to create anyway
              }
            }
            
            await fs.promises.symlink(installInfo.folder, linkPath, 'dir');
            created++;
          } else {
            // Windows: Use mod name in !dzbl folder
            const details = await steamClient.workshop.getItem(workshopId);
            const modName = details?.title || `Mod_${workshopId}`;
            const sanitizedName = sanitizeModName(modName);
            const linkPath = path.join(junctionDir, `@${sanitizedName}`);

            // Check if junction already exists and points to correct target
            if (await pathExists(linkPath)) {
              try {
                if (await isSymlink(linkPath)) {
                  const currentTarget = await getSymlinkTarget(linkPath);
                  if (currentTarget && normalizeLinkPath(currentTarget) === normalizeLinkPath(installInfo.folder)) {
                    cacheJunction(linkPath, installInfo.folder);
                    skipped++;
                    return;
                  }
                  console.log(`🔄 Junction @${sanitizedName} points to wrong target, recreating...`);
                }
              } catch {
                // Error checking, createJunction will handle it
              }
            }

            await createJunction(installInfo.folder, linkPath, `@${sanitizedName}`);
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
