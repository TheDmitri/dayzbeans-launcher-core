import * as path from 'path';
import * as fs from 'fs';
import { app, shell } from 'electron';
import { detectSteamInstallation } from './platform-utils';
import { e2eHooks } from './e2e-hooks';
import { logToFile } from './logger';
import {
  acknowledgeTimestamp,
  acknowledgedTimestamp,
  lastWorkshopTimestamp,
  noteDownloadRequested,
  noteWorkshopTimestamp,
  observeState,
  setAcknowledgementStore,
  setMetadataOnlyGraceMs,
} from './mod-update-tracker';
import { queryWorkshopItems, type WorkshopItemSummary } from './workshop-items';
import Store from 'electron-store';

// Metadata-only workshop edits survive restarts, so the startup sweep does not chase
// them again on every launch (see mod-update-tracker).
setAcknowledgementStore(new Store() as unknown as Parameters<typeof setAcknowledgementStore>[0]);
if (e2eHooks?.timing.metadataOnlyGraceMs !== undefined) {
  setMetadataOnlyGraceMs(e2eHooks.timing.metadataOnlyGraceMs);
}
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Steam integration
let steamworks: any = null;
let steamClient: any = null;
const useSteam = process.env['STEAM_ENABLED'] !== 'false';

export { DAYZ_APP_ID } from './dayz-install-locator';
import { DAYZ_APP_ID } from './dayz-install-locator';

/** Which step of initialization failed — drives the diagnostics the user can read. */
export type SteamInitStage = 'disabled' | 'native-module' | 'appid-file' | 'steam-api';

export interface SteamInitFailure {
  stage: SteamInitStage;
  message: string;
  /** Node error code where there is one (EPERM, EACCES, MODULE_NOT_FOUND, …). */
  code?: string;
  at: string;
  attempts: number;
}

let lastInitFailure: SteamInitFailure | null = null;
let initAttempts = 0;
/** Non-fatal: recorded even when init later succeeds, because it is worth seeing. */
let appIdFileNote: { path: string; written: boolean; error: string | null } | null = null;

/** The last recorded reason initialization failed, or null if it never has. */
export function getLastSteamInitFailure(): SteamInitFailure | null {
  return lastInitFailure;
}

/** Where the steam_appid.txt hint file went, and whether writing it worked. */
export function getSteamAppIdFileNote(): { path: string; written: boolean; error: string | null } | null {
  return appIdFileNote;
}

function recordFailure(stage: SteamInitStage, error: unknown): void {
  const err = error as NodeJS.ErrnoException;
  lastInitFailure = {
    stage,
    message: (err && err.message) || String(error),
    code: err?.code,
    at: new Date().toISOString(),
    attempts: initAttempts,
  };
}

/**
 * Writes the steam_appid.txt hint file into userData.
 *
 * It used to be written into `process.cwd()` — inside the same try/catch as the
 * actual Steam init. That made an unwritable working directory fatal: launched
 * through the `dayzbeans://` protocol handler, from a Run key, or installed under
 * Program Files, cwd is a directory the app cannot write to, `writeFileSync` threw
 * EPERM, and initialization aborted before Steam was ever contacted — with the
 * retry loop failing identically forever. userData is always writable, and this
 * now has its own try/catch so a failed write can only be recorded, never fatal.
 */
function ensureAppIdFile(): string {
  const dir = app.getPath('userData');
  const file = path.join(dir, 'steam_appid.txt');
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').trim() !== DAYZ_APP_ID) {
      fs.writeFileSync(file, DAYZ_APP_ID);
    }
    appIdFileNote = { path: file, written: true, error: null };
  } catch (error) {
    appIdFileNote = { path: file, written: false, error: (error as Error).message };
    logToFile(`⚠️ Could not write steam_appid.txt at ${file}: ${(error as Error).message} (continuing — SteamAppId env var is the primary mechanism)`);
  }
  return dir;
}

/**
 * Initializes Steam integration
 */
export function initializeSteam(quiet = false): boolean {
  if (!useSteam) {
    if (!quiet) logToFile('Steam integration disabled (STEAM_ENABLED=false)');
    recordFailure('disabled', new Error('Steam integration disabled via STEAM_ENABLED=false'));
    return false;
  }

  initAttempts++;

  try {
    // The e2e suite swaps in a scripted Steam workshop (see e2e-hooks.ts); every
    // Steam call in the app goes through the client this returns.
    steamworks = e2eHooks?.fakes.steamworks ?? require('steamworks.js');
  } catch (error) {
    // The native .node is asar-unpacked, so it sits loose on disk where antivirus
    // can quarantine it. Distinguished from an API failure because the fix is
    // completely different (restore/allowlist the file vs. start Steam).
    recordFailure('native-module', error);
    if (!quiet) logToFile(`❌ Failed to load steamworks.js native module: ${(error as Error).message}`);
    steamClient = null;
    return false;
  }

  const appIdDir = ensureAppIdFile();

  // SteamAPI_Init resolves the App ID from the SteamAppId environment variable
  // first, and only falls back to steam_appid.txt in the current working
  // directory. Setting the env var is therefore both more reliable and free of
  // filesystem preconditions. It is set only around the init call and restored
  // straight after: these variables are inherited by children, and
  // `steam -applaunch` behaves differently when it thinks it was started in a
  // game context (see startSteamClient, which strips them for the same reason).
  const previousCwd = process.cwd();
  const previousAppId = process.env['SteamAppId'];
  const previousGameId = process.env['SteamGameId'];

  try {
    process.env['SteamAppId'] = DAYZ_APP_ID;
    process.env['SteamGameId'] = DAYZ_APP_ID;

    // Belt and braces for the file-based path: point cwd at the directory the
    // hint file was actually written to. Restored in the finally below.
    try {
      process.chdir(appIdDir);
    } catch (chdirError) {
      logToFile(`⚠️ Could not chdir to ${appIdDir}: ${(chdirError as Error).message}`);
    }

    steamClient = steamworks.init(Number(DAYZ_APP_ID));
    lastInitFailure = null;
    logToFile('✅ Steam initialized successfully');
    logToFile(`Steam user: ${steamClient.localplayer.getName()}`);

    // Enable Steam overlay for Electron
    steamworks.electronEnableSteamOverlay();

    return true;
  } catch (error) {
    recordFailure('steam-api', error);
    // In quiet mode (e.g. retry loop while Steam is still starting) don't spam the log —
    // "Cannot create IPC pipe to Steam client process" is expected until Steam is ready.
    if (!quiet) logToFile(`❌ Failed to initialize Steam (attempt ${initAttempts}): ${(error as Error).message}`);
    steamClient = null;
    return false;
  } finally {
    if (previousAppId === undefined) delete process.env['SteamAppId'];
    else process.env['SteamAppId'] = previousAppId;
    if (previousGameId === undefined) delete process.env['SteamGameId'];
    else process.env['SteamGameId'] = previousGameId;
    try {
      process.chdir(previousCwd);
    } catch { /* original cwd went away; nothing useful to do */ }
  }
}

/**
 * Checks if Steam is initialized
 */
export function isSteamInitialized(): boolean {
  return steamClient !== null;
}

// Throttle re-init attempts so a spuriously-failing init can't be hammered.
let lastInitAttempt = 0;
const INIT_RETRY_COOLDOWN = 3000; // ms

/**
 * Ensures the steamworks.js client is initialized, retrying init if it failed at
 * startup (common on Linux when the launcher starts before the Steam client is
 * ready — steamClient then stays null forever with no retry). Returns true if a
 * usable client is available.
 */
export function ensureSteamInitialized(): boolean {
  if (steamClient) return true;

  const now = Date.now();
  if (now - lastInitAttempt < INIT_RETRY_COOLDOWN) {
    return false;
  }
  lastInitAttempt = now;

  logToFile('🔄 Steam client not initialized — attempting (re)initialization...');
  return initializeSteam();
}

/**
 * Launches the Steam client if it is not already running.
 * Uses the detected installation (native / flatpak / windows / mac) and starts Steam
 * with `-silent` where supported so it comes up minimized to the tray.
 * Returns:
 *   'running'     - Steam was already running (nothing launched)
 *   'launched'    - a launch was triggered
 *   'unavailable' - Steam is not installed / could not be launched
 */
export async function startSteamClient(): Promise<'running' | 'launched' | 'unavailable'> {
  const { detectSteamInstallation } = require('./platform-utils');
  const install = await detectSteamInstallation();

  if (install.isRunning) return 'running';
  if (install.type === 'none' || !install.isInstalled) return 'unavailable';

  try {
    // Launch the Steam *client* in a clean environment. If Steam game-context vars
    // (SteamAppId/SteamGameId/…) are inherited, Steam thinks it's being launched to run a
    // specific game and won't start the client normally — so strip them for the child.
    const childEnv = { ...process.env };
    delete childEnv['SteamAppId'];
    delete childEnv['SteamGameId'];
    delete childEnv['SteamOverlayGameId'];
    delete childEnv['SteamClientLaunch'];
    delete childEnv['SteamEnv'];

    const opts = { detached: true, stdio: 'ignore' as const, env: childEnv };
    let child;

    if (process.platform === 'win32') {
      const exe = install.installPath ? path.join(install.installPath, 'steam.exe') : 'steam.exe';
      child = spawn(exe, ['-silent'], opts);
    } else if (install.type === 'flatpak') {
      child = spawn('flatpak', ['run', 'com.valvesoftware.Steam', '-silent'], opts);
    } else if (process.platform === 'darwin') {
      // macOS has no -silent equivalent via `open`; just launch the app.
      child = spawn('open', ['-a', 'Steam'], opts);
    } else {
      child = spawn('steam', ['-silent'], opts);
    }

    child.on('error', (err) => logToFile(`Failed to launch Steam: ${err}`));
    child.unref();
    logToFile('🚀 Launched Steam client');
    return 'launched';
  } catch (e) {
    logToFile(`Failed to launch Steam: ${e}`);
    return 'unavailable';
  }
}

/**
 * Polls until the steamworks.js client initializes, or the timeout elapses. Intended to
 * be called after startSteamClient() at startup.
 *
 * We retry initializeSteam() directly (quietly) rather than gating on our own
 * isSteamRunning() process check: a freshly-launched Steam has a `steam` process almost
 * immediately, but its client IPC pipe isn't ready for many seconds (SteamAPI_Init fails
 * with "Cannot create IPC pipe to Steam client process" until then). SteamAPI_Init is the
 * authoritative readiness signal, so we just keep trying it until it succeeds. Steam cold
 * starts (and first-run updates/login) can take a while, hence the generous window.
 */
export async function waitForSteamAndInitialize(timeoutMs = 90000): Promise<boolean> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const start = Date.now();
  let attempts = 0;

  while (Date.now() - start < timeoutMs) {
    if (steamClient) return true;
    attempts++;
    if (initializeSteam(true)) {
      logToFile(`✅ Steam initialized after ${attempts} attempt(s)`);
      return true;
    }
    // 5s interval: steamworks' native lib prints a line per attempt that we can't
    // suppress, so avoid hammering it while Steam finishes starting.
    await sleep(5000);
  }

  const failure = getLastSteamInitFailure();
  logToFile(`⚠️ Steam did not become ready within ${timeoutMs / 1000}s (${attempts} attempts). Last error [${failure?.stage}]: ${failure?.message ?? 'none recorded'}`);
  return false;
}

/**
 * Gets Steam user information
 */
// Cache for Steam avatar URL (fetched once per session)
let cachedAvatarUrl: string | null = null;

export function getSteamUserInfo(): any {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  try {
    const steamId = steamClient.localplayer.getSteamId();
    const name = steamClient.localplayer.getName();

    // Convert steamId object to string
    let steamIdString: string | undefined;
    if (steamId) {
      if (typeof steamId === 'object' && 'steamId64' in steamId) {
        steamIdString = steamId.steamId64.toString();
      } else {
        steamIdString = steamId.toString();
      }
    }

    const result = {
      success: true,
      steamId: steamIdString,
      personaName: name || undefined,
      avatarUrl: cachedAvatarUrl || undefined,
      ...(typeof steamClient.localplayer.getLevel === 'function' && {
        level: steamClient.localplayer.getLevel()
      })
    };

    // Fetch avatar in background if not cached yet
    if (!cachedAvatarUrl && steamIdString) {
      fetchSteamAvatar(steamIdString).catch(() => {});
    }

    return result;
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Fetch Steam avatar URL from Steam Community XML profile.
 * Runs in Electron main process (no CORS).
 */
async function fetchSteamAvatar(steamId64: string): Promise<void> {
  try {
    const https = require('https');
    const url = `https://steamcommunity.com/profiles/${steamId64}?xml=1`;

    const xml: string = await new Promise((resolve, reject) => {
      https.get(url, { timeout: 5000 }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });

    // Extract avatarMedium from XML (simple regex, no XML parser needed)
    const match = xml.match(/<avatarMedium><!\[CDATA\[(.*?)\]\]><\/avatarMedium>/);
    if (match?.[1]) {
      cachedAvatarUrl = match[1];
      console.log(`✅ Steam avatar cached: ${cachedAvatarUrl}`);
    }
  } catch (error) {
    console.warn('Could not fetch Steam avatar:', (error as Error).message);
  }
}

/**
 * Gets subscribed Steam Workshop items - FAST MODE
 * Only retrieves essential local data (workshopId, name from folder, size, install status)
 * Does NOT make network calls to Steam API - instant response
 */
export async function getSubscribedItemsFast(): Promise<any> {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  try {
    const startTime = Date.now();
    const subscribedItems = steamClient.workshop.getSubscribedItems();
    console.log(`⚡ Fast loading ${subscribedItems.length} subscribed items...`);
    
    const itemDetails = subscribedItems.map((itemId: bigint) => {
      try {
        // Only get LOCAL data - no network calls
        let installInfo = null;
        let itemState = null;
        
        try {
          installInfo = steamClient.workshop.installInfo(itemId);
        } catch (e) { /* ignore */ }
        
        try {
          itemState = steamClient.workshop.state(itemId);
        } catch (e) { /* ignore */ }
        
        // Extract mod name from folder path (e.g., "D:\Steam\...\@ModName" -> "ModName")
        let modName = `Mod ${itemId}`;
        if (installInfo?.folder) {
          const folderName = installInfo.folder.split(/[/\\]/).pop() || '';
          // Remove @ prefix if present
          modName = folderName.startsWith('@') ? folderName.substring(1) : folderName;
        }
        
        return {
          publishedFileId: itemId.toString(),
          title: modName,
          fileSize: installInfo ? Number(installInfo.sizeOnDisk) : 0,
          installPath: installInfo?.folder || '',
          isInstalled: !!(installInfo?.folder) || !!(itemState && (itemState & 4)),
          itemState: itemState || 0,
          // Minimal defaults for compatibility
          description: '',
          tags: [],
          previewUrl: '',
          timeCreated: 0,
          timeUpdated: 0,
          subscriptions: 0,
          favorited: 0
        };
      } catch (itemError) {
        return {
          publishedFileId: itemId.toString(),
          title: `Mod ${itemId}`,
          fileSize: 0,
          installPath: '',
          isInstalled: false,
          itemState: 0,
          description: '',
          tags: [],
          previewUrl: '',
          timeCreated: 0,
          timeUpdated: 0,
          subscriptions: 0,
          favorited: 0
        };
      }
    });

    const elapsed = Date.now() - startTime;
    console.log(`⚡ Fast load completed: ${itemDetails.length} items in ${elapsed}ms`);
    
    return { success: true, items: itemDetails, loadTime: elapsed };
  } catch (error) {
    console.error('Error in fast subscribed items:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Gets subscribed Steam Workshop items - FULL MODE (with Steam API details)
 * Makes network calls to Steam API for each item - slower but complete data
 * Use getSubscribedItemsFast() for initial load, then enrich with this if needed
 */
export async function getSubscribedItems(): Promise<any> {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  try {
    const startTime = Date.now();
    const subscribedItems = steamClient.workshop.getSubscribedItems();
    console.log(`📦 Full loading ${subscribedItems.length} subscribed items (with Steam API)...`);
    
    // Process items in parallel batches for speed
    const BATCH_SIZE = 10; // Process 10 items at a time
    const itemDetails: any[] = [];
    
    for (let i = 0; i < subscribedItems.length; i += BATCH_SIZE) {
      const batch = subscribedItems.slice(i, i + BATCH_SIZE);
      
      const batchResults = await Promise.all(
        batch.map(async (itemId: bigint) => {
          try {
            let installInfo = null;
            let details = null;
            let itemState = null;

            // Get local install info (fast, no network)
            try {
              installInfo = steamClient.workshop.installInfo(itemId);
            } catch (e) { /* ignore */ }

            // Get item state (fast, no network)
            try {
              itemState = steamClient.workshop.state(itemId);
            } catch (e) { /* ignore */ }

            // Get full details from Steam API (SLOW - network call)
            try {
              details = await steamClient.workshop.getItem(itemId);
            } catch (e) { /* ignore */ }

            // Extract mod name from folder if no title from API
            let modName = `Mod ${itemId}`;
            if (details?.title) {
              modName = details.title;
            } else if (installInfo?.folder) {
              const folderName = installInfo.folder.split(/[/\\]/).pop() || '';
              modName = folderName.startsWith('@') ? folderName.substring(1) : folderName;
            }

            return {
              publishedFileId: itemId.toString(),
              title: modName,
              description: details?.description || '',
              tags: details?.tags || [],
              previewUrl: details?.previewUrl || '',
              fileSize: installInfo ? Number(installInfo.sizeOnDisk) : 0,
              timeCreated: details?.timeCreated || 0,
              timeUpdated: details?.timeUpdated || 0,
              visibility: details?.visibility || 0,
              banned: details?.banned || false,
              acceptedForUse: details?.acceptedForUse || false,
              subscriptions: details?.statistics ? Number(details.statistics.numSubscriptions) : 0,
              favorited: details?.statistics ? Number(details.statistics.numFavorites) : 0,
              followers: details?.statistics ? Number(details.statistics.numFollowers) : 0,
              views: details?.statistics ? Number(details.statistics.numUniqueWebsiteViews) : 0,
              installPath: installInfo?.folder || '',
              isInstalled: !!(installInfo?.folder) || !!(itemState && (itemState & 4)),
              itemState: itemState || 0
            };
          } catch (itemError) {
            console.warn(`Error getting full info for item ${itemId}:`, itemError);
            return {
              publishedFileId: itemId.toString(),
              title: `Mod ${itemId}`,
              description: '',
              tags: [],
              previewUrl: '',
              fileSize: 0,
              timeCreated: 0,
              timeUpdated: 0,
              visibility: 0,
              banned: false,
              acceptedForUse: false,
              subscriptions: 0,
              favorited: 0,
              followers: 0,
              views: 0,
              installPath: '',
              isInstalled: false,
              itemState: 0
            };
          }
        })
      );
      
      itemDetails.push(...batchResults);
    }

    const elapsed = Date.now() - startTime;
    console.log(`📦 Full load completed: ${itemDetails.length} items in ${elapsed}ms`);
    
    return { success: true, items: itemDetails, loadTime: elapsed };
  } catch (error) {
    console.error('Error getting subscribed items:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Gets workshop item details directly from Steam API (fresh, not cached)
 * This is useful for checking if updates are available
 */
export async function getWorkshopItemDetails(publishedFileId: string): Promise<any> {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  try {
    const itemId = BigInt(publishedFileId);
    const details = await steamClient.workshop.getItem(itemId);
    
    if (details) {
      return {
        success: true,
        workshopId: publishedFileId,
        title: details.title || '',
        description: details.description || '',
        timeCreated: details.timeCreated || 0,
        timeUpdated: details.timeUpdated || 0,
        fileSize: details.fileSize || 0,
        tags: details.tags || [],
        previewUrl: details.previewUrl || ''
      };
    } else {
      return { success: false, error: 'Item not found' };
    }
  } catch (error) {
    console.error('Error getting workshop item details:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Subscribes to a Steam Workshop item and triggers download
 * BUG-003: Uses steamworks.js only. Returns explicit error on failure instead
 * of silently falling back to opening the Steam Workshop page in a browser.
 */
export async function subscribeToItem(publishedFileId: string): Promise<any> {
  const installation = await detectSteamInstallation();

  if (installation.type === 'none') {
    return { success: false, error: 'Steam is not running. Please start Steam and restart the launcher.' };
  }

  // Steam is running; if the client failed to init at startup (e.g. launcher started
  // first on Linux), retry now before giving up.
  if (!steamClient && !ensureSteamInitialized()) {
    return {
      success: false,
      error: 'Steam API not initialized. Try running the launcher as administrator, or add it as a non-Steam game in your Steam library.',
      requiresElevation: true
    };
  }

  try {
    const itemId = BigInt(publishedFileId);
    await steamClient.workshop.subscribe(itemId);
    const downloadStarted = requestWorkshopDownload(itemId, true);
    console.log(`📥 [steamworks.js] Subscribe + download triggered for ${publishedFileId}`);
    return { success: true, downloadStarted, method: 'steamworks' };
  } catch (error) {
    const errorMessage = (error as Error).message || 'Unknown error';
    console.error(`❌ Steamworks subscribe failed for ${publishedFileId}:`, errorMessage);

    // Return actionable error instead of silently opening browser
    return {
      success: false,
      error: `Failed to subscribe to mod. ${errorMessage}. Try running the launcher as administrator or restart Steam.`,
      requiresElevation: true,
      workshopId: publishedFileId
    };
  }
}

/**
 * Unsubscribes from a Steam Workshop item and stops any active download
 */
export async function unsubscribeFromItem(publishedFileId: string): Promise<any> {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  try {
    const itemId = BigInt(publishedFileId);
    
    // Get current state before unsubscribe
    const stateBefore = steamClient.workshop.state(itemId);
    console.log(`🛑 Unsubscribing from ${publishedFileId}, state before: ${stateBefore}`);
    
    // Unsubscribe from the item
    const result = await steamClient.workshop.unsubscribe(itemId);
    
    // Get state after unsubscribe
    const stateAfter = steamClient.workshop.state(itemId);
    console.log(`✅ Unsubscribed from ${publishedFileId}, state after: ${stateAfter}, result:`, result);
    
    return { success: true, result, stateBefore, stateAfter };
  } catch (error) {
    console.error('Error unsubscribing from item:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Gets download info for a Steam Workshop item
 * steamworks.js downloadInfo returns { current: bigint, total: bigint } or null
 * 
 * Item state bits:
 * - 1 = Subscribed
 * - 4 = Installed  
 * - 8 = Needs Update
 * - 16 = Downloading
 * - 32 = Download Pending
 */
export async function getItemDownloadInfo(publishedFileId: string): Promise<any> {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  try {
    const itemId = BigInt(publishedFileId);
    
    // Get item state to check download status
    const itemState = steamClient.workshop.state(itemId);
    const isDownloading = !!(itemState & 16);
    const isDownloadPending = !!(itemState & 32);
    const isInstalled = !!(itemState & 4);
    
    // Get download progress info
    const downloadInfo = steamClient.workshop.downloadInfo(itemId);
    
    // downloadInfo can be null if no download is in progress
    if (!downloadInfo) {
      console.log(`📊 No download info for ${publishedFileId} - state: ${itemState} (installed: ${isInstalled}, downloading: ${isDownloading}, pending: ${isDownloadPending})`);
      return { 
        success: true, 
        bytesDownloaded: 0,
        bytesTotal: 0,
        active: isDownloading || isDownloadPending,
        itemState,
        isInstalled,
        isDownloading,
        isDownloadPending
      };
    }
    
    // steamworks.js uses 'current' and 'total' property names (bigint)
    const bytesDownloaded = Number(downloadInfo.current || 0n);
    const bytesTotal = Number(downloadInfo.total || 0n);
    
    console.log(`📊 Download info for ${publishedFileId}: ${bytesDownloaded}/${bytesTotal} bytes (state: ${itemState})`);
    
    return { 
      success: true, 
      bytesDownloaded,
      bytesTotal,
      active: bytesTotal > 0 || isDownloading,
      itemState,
      isInstalled,
      isDownloading,
      isDownloadPending
    };
  } catch (error) {
    console.error('Error getting download info:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Checks if a mod is installed on disk
 * 
 * Item state bits:
 * - 1 = Subscribed
 * - 4 = Installed  
 * - 8 = Needs Update
 * - 16 = Downloading
 * - 32 = Download Pending
 * 
 * A mod is considered "installed" if:
 * 1. Steam reports it as installed (state & 4)
 * 2. The folder actually exists on disk
 * 
 * NOTE: We do NOT check subscription state here because:
 * - Steam's subscription bit may not update immediately after subscribe/unsubscribe
 * - The Angular layer tracks locally unsubscribed items separately
 * - For server mod verification, we only care if files exist and are usable
 */
export async function isModInstalled(publishedFileId: string): Promise<any> {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  const fs = require('fs');
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 500; // 500ms between retries

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const itemId = BigInt(publishedFileId);
      const itemState = steamClient.workshop.state(itemId);
      
      // Check subscription and installation state (for reporting, not for isInstalled decision)
      const isSubscribed = !!(itemState & 1);  // Bit 1 = Subscribed
      const stateInstalled = !!(itemState & 4); // Bit 4 = Installed
      
      // Also check if the mod folder actually exists on disk
      let folderExists = false;
      let installPath = '';
      
      if (stateInstalled) {
        try {
          const installInfo = steamClient.workshop.installInfo(itemId);
          if (installInfo?.folder) {
            installPath = installInfo.folder;
            folderExists = fs.existsSync(installInfo.folder);
            
            if (!folderExists && attempt < MAX_RETRIES - 1) {
              // Folder doesn't exist yet, wait and retry
              console.log(`⏳ Mod ${publishedFileId} folder not ready, retrying in ${RETRY_DELAY}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
              continue;
            }
            
            if (!folderExists) {
              console.warn(`⚠️ Mod ${publishedFileId} marked as installed but folder doesn't exist after ${MAX_RETRIES} attempts: ${installInfo.folder}`);
            }
          }
        } catch (installError) {
          console.warn(`Could not get install info for ${publishedFileId}:`, (installError as Error).message);
        }
      }
      
      // Mod is installed if Steam says so AND folder exists
      // Subscription state is tracked separately at the Angular layer
      const isInstalled = stateInstalled && folderExists;

      return { 
        success: true, 
        isInstalled, 
        itemState,
        isSubscribed,
        stateInstalled,
        folderExists,
        installPath
      };
    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        console.log(`⏳ Error checking mod ${publishedFileId}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
      console.error(`Error checking install state for item ${publishedFileId}:`, error);
      return { success: false, error: (error as Error).message };
    }
  }
  
  // Should not reach here, but just in case
  return { success: false, error: 'Max retries exceeded' };
}

// =============================================================================
// Mod freshness
// =============================================================================

/** ISteamUGC EItemState bits, named so call sites stop open-coding `state & 8`. */
export const ITEM_STATE = {
  SUBSCRIBED: 1,
  LEGACY_ITEM: 2,
  INSTALLED: 4,
  NEEDS_UPDATE: 8,
  DOWNLOADING: 16,
  DOWNLOAD_PENDING: 32,
} as const;

export type ModUpdateReason =
  | 'up-to-date'
  | 'not-installed'
  | 'folder-missing'
  | 'steam-flag'
  | 'timestamp'
  | 'metadata-only'
  | 'downloading'
  | 'steam-unavailable'
  | 'error';

export interface ModUpdateStatus {
  success: boolean;
  workshopId: string;
  itemState: number;
  /** Steam says installed AND the folder is on disk. */
  isInstalled: boolean;
  /** Installed, but the copy on disk is older than the workshop's. */
  needsUpdate: boolean;
  isDownloading: boolean;
  /** THE launch gate: installed, not stale, nothing in flight. */
  isUpToDate: boolean;
  folder: string | null;
  localTimestamp: number;
  workshopTimestamp: number;
  /**
   * Newest workshop version known to need no download (a metadata-only edit, see
   * mod-update-tracker), or 0. Waits that expect the install timestamp to reach a
   * version must accept this one as reaching it.
   */
  acknowledgedTimestamp: number;
  reason: ModUpdateReason;
  error?: string;
}

/**
 * Ask Steam to download a workshop item, and record the request so a download Steam
 * never starts (a metadata-only edit) can be recognised instead of waited on forever.
 * Every download request goes through here.
 */
export function requestWorkshopDownload(workshopId: bigint, highPriority: boolean): boolean {
  noteDownloadRequested(workshopId.toString());
  return getSteamClient().workshop.download(workshopId, highPriority);
}

/**
 * The one place that decides whether a mod on disk is the version the workshop has.
 *
 * Two independent signals, because neither is sufficient alone:
 *
 * 1. `EItemState.NeedsUpdate` (bit 8). Authoritative when set, but it is only set once
 *    the Steam client has itself noticed the update. A client that started moments ago,
 *    or one that has not refreshed its UGC state, reports 0 for a mod that is months
 *    stale. Every check in the join path used to rely on this bit alone, which is why a
 *    player could update a mod and still be rejected by the server.
 *
 * 2. Install timestamp vs the workshop's `timeUpdated`. Survives a cold Steam client,
 *    costs one UGC query. Pass `queryWorkshop: false` in a tight polling loop where the
 *    flags are enough and the query would run every tick, or `workshopItem` when a
 *    batched query already fetched it (see getModUpdateStatuses).
 *
 * `isUpToDate` is deliberately conservative: anything in flight, any missing folder, any
 * failure to ask Steam all answer false. Callers gate the launch on it, and launching a
 * stale mod costs the player a rejected connection, while a false negative costs a wait.
 */
export async function getModUpdateStatus(
  publishedFileId: string,
  options: { queryWorkshop?: boolean; workshopItem?: WorkshopItemSummary } = {}
): Promise<ModUpdateStatus> {
  const queryWorkshop = options.queryWorkshop !== false;

  const base: ModUpdateStatus = {
    success: false,
    workshopId: publishedFileId,
    itemState: 0,
    isInstalled: false,
    needsUpdate: false,
    isDownloading: false,
    isUpToDate: false,
    folder: null,
    localTimestamp: 0,
    workshopTimestamp: 0,
    acknowledgedTimestamp: 0,
    reason: 'steam-unavailable',
  };

  if (!steamClient) {
    return { ...base, error: 'Steam not initialized' };
  }

  try {
    const itemId = BigInt(publishedFileId);
    const itemState: number = steamClient.workshop.state(itemId) || 0;
    const isDownloading = !!(itemState & (ITEM_STATE.DOWNLOADING | ITEM_STATE.DOWNLOAD_PENDING));
    const stateInstalled = !!(itemState & ITEM_STATE.INSTALLED);

    let folder: string | null = null;
    let localTimestamp = 0;

    if (stateInstalled) {
      try {
        const installInfo = steamClient.workshop.installInfo(itemId);
        if (installInfo?.folder) {
          folder = installInfo.folder;
          localTimestamp = Number(installInfo.timestamp) || 0;
        }
      } catch (error) {
        console.warn(`Could not read install info for ${publishedFileId}:`, (error as Error).message);
      }
    }

    const folderExists = !!folder && fs.existsSync(folder);
    const isInstalled = stateInstalled && folderExists;

    if (!isInstalled) {
      return {
        ...base,
        success: true,
        itemState,
        isDownloading,
        folder,
        localTimestamp,
        reason: stateInstalled ? 'folder-missing' : 'not-installed',
      };
    }

    let needsUpdate = !!(itemState & ITEM_STATE.NEEDS_UPDATE);
    let reason: ModUpdateReason = needsUpdate ? 'steam-flag' : 'up-to-date';
    let workshopTimestamp = 0;

    // Steam was asked for this item and never showed any activity: the workshop edit
    // that flagged it changed no files. Remember that version so it stops being flagged.
    const metadataOnly = observeState(publishedFileId, {
      isInstalled,
      isDownloading,
      needsUpdateFlag: needsUpdate,
    });
    if (metadataOnly) {
      const edit = lastWorkshopTimestamp(publishedFileId);
      acknowledgeTimestamp(publishedFileId, edit);
      reason = 'metadata-only';
      console.log(`ℹ️ ${publishedFileId}: Steam had nothing to download for workshop version ${edit} (metadata-only edit)`);
    }
    let acknowledged = acknowledgedTimestamp(publishedFileId);

    if (!needsUpdate && queryWorkshop) {
      try {
        const details = options.workshopItem ?? await steamClient.workshop.getItem(itemId);
        workshopTimestamp = Number(details?.timeUpdated) || 0;
        noteWorkshopTimestamp(publishedFileId, workshopTimestamp);
        if (metadataOnly && workshopTimestamp > acknowledged) {
          acknowledgeTimestamp(publishedFileId, workshopTimestamp);
          acknowledged = workshopTimestamp;
        }

        const installedVersion = Math.max(localTimestamp, acknowledged);
        if (workshopTimestamp > 0 && localTimestamp > 0 && workshopTimestamp > installedVersion) {
          needsUpdate = true;
          reason = 'timestamp';
        }
      } catch (error) {
        // A failed UGC query is not evidence of staleness — fall back to the state bit.
        console.warn(`Workshop query failed for ${publishedFileId}:`, (error as Error).message);
      }
    }

    if (!needsUpdate && isDownloading) {
      reason = 'downloading';
    }

    return {
      success: true,
      workshopId: publishedFileId,
      itemState,
      isInstalled,
      needsUpdate,
      isDownloading,
      isUpToDate: !needsUpdate && !isDownloading,
      folder,
      localTimestamp,
      workshopTimestamp,
      acknowledgedTimestamp: acknowledged,
      reason,
    };
  } catch (error) {
    return { ...base, reason: 'error', error: (error as Error).message };
  }
}

/** Convenience wrapper: true only when the copy on disk is safe to launch. */
export async function isModUpToDate(
  publishedFileId: string,
  options: { queryWorkshop?: boolean } = {}
): Promise<boolean> {
  return (await getModUpdateStatus(publishedFileId, options)).isUpToDate;
}

/**
 * Freshness for many mods, in parallel batches.
 *
 * The workshop timestamps come from one batched UGC query per page of mods instead of one
 * query per mod. Pass `workshopItems` when the caller already ran that query (the sweep
 * also wants the titles). A mod the batched query did not cover falls back to its own query.
 */
export async function getModUpdateStatuses(
  publishedFileIds: string[],
  options: { queryWorkshop?: boolean; workshopItems?: Map<string, WorkshopItemSummary> } = {}
): Promise<ModUpdateStatus[]> {
  const BATCH_SIZE = 15;
  const results: ModUpdateStatus[] = [];
  const { workshopItems: provided, ...statusOptions } = options;
  const workshopItems = provided
    ?? (steamClient && options.queryWorkshop !== false ? await fetchWorkshopItems(publishedFileIds) : undefined);

  for (let i = 0; i < publishedFileIds.length; i += BATCH_SIZE) {
    const batch = publishedFileIds.slice(i, i + BATCH_SIZE);
    results.push(...await Promise.all(batch.map(id =>
      getModUpdateStatus(id, { ...statusOptions, workshopItem: workshopItems?.get(id) }))));
  }

  return results;
}

/** Titles and timestamps for many workshop items, one UGC query per page (see workshop-items). */
export async function fetchWorkshopItems(publishedFileIds: string[]): Promise<Map<string, WorkshopItemSummary>> {
  if (!steamClient) return new Map();
  return queryWorkshopItems(ids => steamClient.workshop.getItems(ids), publishedFileIds);
}

/**
 * Forces a download to start/resume for a workshop item
 * Useful when Steam has paused or not started the download
 */
export async function forceDownloadItem(publishedFileId: string): Promise<any> {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  try {
    const itemId = BigInt(publishedFileId);
    
    // Call download with high priority to force it to start/resume
    const result = requestWorkshopDownload(itemId, true);
    console.log(`🔄 Force download triggered for ${publishedFileId}, result: ${result}`);
    
    return { success: true, downloadStarted: result };
  } catch (error) {
    console.error('Error forcing download:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Gets install info for a Steam Workshop item
 */
export async function getItemInstallInfo(publishedFileId: string): Promise<any> {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  try {
    const itemId = BigInt(publishedFileId);

    // Get install info using correct API method
    const installInfo = steamClient.workshop.installInfo(itemId);

    if (installInfo) {
      return {
        success: true,
        installInfo: {
          folder: installInfo.folder,
          sizeOnDisk: Number(installInfo.sizeOnDisk),
          timestamp: installInfo.timestamp,
          isInstalled: true
        }
      };
    } else {
      // Try to get state info as fallback
      const itemState = steamClient.workshop.state(itemId);
      return {
        success: true,
        installInfo: {
          folder: '',
          sizeOnDisk: 0,
          timestamp: 0,
          isInstalled: !!(itemState && (itemState & 4)), // 4 = installed flag
          itemState: itemState
        }
      };
    }
  } catch (error) {
    console.error('Error getting install info:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Gets mod sizes for multiple workshop items
 * Returns individual sizes and total size
 */
export async function getModSizes(workshopIds: string[]): Promise<any> {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  try {
    const results: { workshopId: string; size: number; name?: string; error?: string }[] = [];
    let totalSize = 0;
    let successCount = 0;
    let failCount = 0;

    console.log(`📊 Getting sizes for ${workshopIds.length} mods...`);

    for (const workshopId of workshopIds) {
      try {
        const itemId = BigInt(workshopId);
        let size = 0;
        let name: string | undefined;
        
        // First try: installInfo for installed mods (most reliable for size)
        try {
          const installInfo = steamClient.workshop.installInfo(itemId);
          if (installInfo && installInfo.sizeOnDisk) {
            size = Number(installInfo.sizeOnDisk);
            console.log(`📦 Mod ${workshopId}: installInfo size = ${(size / (1024 * 1024)).toFixed(1)} MB`);
          }
        } catch (e) {
          // installInfo not available
        }
        
        // Second try: getItem for details (may have file size in statistics)
        if (size === 0) {
          try {
            const details = await steamClient.workshop.getItem(itemId);
            if (details) {
              name = details.title;
              // Check various possible locations for file size
              if (details.fileSize) {
                size = Number(details.fileSize);
              } else if (details.statistics?.fileSize) {
                size = Number(details.statistics.fileSize);
              } else if (details.file_size) {
                size = Number(details.file_size);
              }
              console.log(`📦 Mod ${workshopId} (${name}): getItem size = ${(size / (1024 * 1024)).toFixed(1)} MB`);
            }
          } catch (e) {
            // getItem not available
          }
        }
        
        if (size > 0) {
          results.push({ workshopId, size, name });
          totalSize += size;
          successCount++;
        } else {
          results.push({ workshopId, size: 0, name, error: 'Size not available' });
          failCount++;
        }
      } catch (itemError) {
        console.warn(`Failed to get size for mod ${workshopId}:`, (itemError as Error).message);
        results.push({
          workshopId,
          size: 0,
          error: (itemError as Error).message
        });
        failCount++;
      }
    }

    console.log(`📊 Mod sizes complete: ${successCount} success, ${failCount} failed, total: ${(totalSize / (1024 * 1024 * 1024)).toFixed(2)} GB`);

    return {
      success: true,
      mods: results,
      totalSize,
      totalSizeFormatted: formatSize(totalSize),
      successCount,
      failCount
    };
  } catch (error) {
    console.error('Error getting mod sizes:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Gets workshop item details for multiple items in batch
 * Uses parallel processing for speed - fetches from Steam API directly
 * Returns full mod details including preview images, descriptions, stats
 */
export async function getWorkshopItemDetailsBatch(publishedFileIds: string[]): Promise<any> {
  if (!steamClient) {
    return { success: false, error: 'Steam not initialized' };
  }

  if (publishedFileIds.length === 0) {
    return { success: true, items: [], loadTime: 0 };
  }

  try {
    const startTime = Date.now();
    console.log(`🔄 Batch fetching details for ${publishedFileIds.length} mods from Steam API...`);
    
    // Process in parallel batches for speed
    const BATCH_SIZE = 15; // Process 15 items at a time
    const allResults: any[] = [];
    
    for (let i = 0; i < publishedFileIds.length; i += BATCH_SIZE) {
      const batch = publishedFileIds.slice(i, i + BATCH_SIZE);
      
      const batchResults = await Promise.all(
        batch.map(async (publishedFileId) => {
          try {
            const itemId = BigInt(publishedFileId);
            
            // Get full details from Steam API
            const details = await steamClient.workshop.getItem(itemId);
            
            // Get local install info
            let installInfo = null;
            let itemState = null;
            
            try {
              installInfo = steamClient.workshop.installInfo(itemId);
            } catch (e) { /* ignore */ }
            
            try {
              itemState = steamClient.workshop.state(itemId);
            } catch (e) { /* ignore */ }
            
            if (details) {
              return {
                success: true,
                workshopId: publishedFileId,
                title: details.title || '',
                description: details.description || '',
                timeCreated: details.timeCreated || 0,
                timeUpdated: details.timeUpdated || 0,
                fileSize: installInfo ? Number(installInfo.sizeOnDisk) : (details.fileSize || 0),
                tags: details.tags || [],
                previewUrl: details.previewUrl || '',
                visibility: details.visibility || 0,
                banned: details.banned || false,
                acceptedForUse: details.acceptedForUse || false,
                subscriptions: details.statistics ? Number(details.statistics.numSubscriptions) : 0,
                favorited: details.statistics ? Number(details.statistics.numFavorites) : 0,
                followers: details.statistics ? Number(details.statistics.numFollowers) : 0,
                views: details.statistics ? Number(details.statistics.numUniqueWebsiteViews) : 0,
                installPath: installInfo?.folder || '',
                isInstalled: !!(installInfo?.folder) || !!(itemState && (itemState & 4)),
                itemState: itemState || 0
              };
            } else {
              return {
                success: false,
                workshopId: publishedFileId,
                error: 'Item not found'
              };
            }
          } catch (error) {
            console.warn(`Error fetching details for ${publishedFileId}:`, error);
            return {
              success: false,
              workshopId: publishedFileId,
              error: (error as Error).message
            };
          }
        })
      );
      
      allResults.push(...batchResults);
      
      // Log progress for large batches
      if (publishedFileIds.length > BATCH_SIZE) {
        console.log(`  Progress: ${Math.min(i + BATCH_SIZE, publishedFileIds.length)}/${publishedFileIds.length}`);
      }
    }
    
    const successCount = allResults.filter(r => r.success).length;
    const elapsed = Date.now() - startTime;
    console.log(`✅ Batch fetch completed: ${successCount}/${publishedFileIds.length} items in ${elapsed}ms`);
    
    return { 
      success: true, 
      items: allResults.filter(r => r.success),
      failedItems: allResults.filter(r => !r.success),
      successCount,
      failCount: publishedFileIds.length - successCount,
      loadTime: elapsed 
    };
  } catch (error) {
    console.error('Error in batch workshop details:', error);
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Formats bytes to human readable size
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Gets the Steam client instance
 */
export function getSteamClient(): any {
  return steamClient;
}
