import { shell, Notification, dialog, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';

// Initialize electron store
const store = new Store();

// Shared file logger (userData/app-debug.log) — see ./logger.
import { logToFile, getLogFilePath } from './logger';

// Import services
import { getMainWindow, setCloseToTray, setIsMinimizedToTray, getIsMinimizedToTray } from './main';
import { launchDayZ, killDayZProcesses, findDayZExecutable, validateAndFixDayZPath } from './dayz-launcher';
import { scanDayZProfiles, cloneDayZProfile, detectProfileDrift, resolveProfilesFolder } from './dayz-profiles';
import { downloadAndVerifyMods, createModJunctions, cancelDownloadProcess, sweepModUpdates, beginJoinPhase } from './mod-management';
import { pingServer } from './ping-service';
import { pingServerGameDig, pingServersGameDig, getServerInfoGameDig, clearPingCache } from './gamedig-ping-service';
import { isSteamInitialized, ensureSteamInitialized, getSteamUserInfo, getSubscribedItems, getSubscribedItemsFast, subscribeToItem, unsubscribeFromItem, getItemDownloadInfo, isModInstalled, getItemInstallInfo, forceDownloadItem, getModSizes, getWorkshopItemDetails, getWorkshopItemDetailsBatch, getModUpdateStatus, getModUpdateStatuses } from './steam-service';
import { discordService, PresenceData } from './discord-service';
import { getAnonymousId } from './anonymous-id';
import { getSuspensionState } from './app-suspension';
import {
  SNAPSHOT_FILENAME,
  clearSnapshot,
  readSnapshot,
  statSnapshot,
  writeSnapshot,
  type SnapshotFs
} from './snapshot-store';
import { getActualDayZWorkshopPath, findUninstalledDayZFolder } from './platform-utils';
import { isAllowedExternalUrl } from './external-url';
import { GAME_EDITIONS, editionOf } from './dayz-install-locator';
import { discoverLocalServers, queryAddress } from './local-servers/local-server-discovery';

// Every channel below is registered through `handle`, which will not compile
// without a schema for its arguments — see ./ipc-register for why that is not
// optional.
import { z } from 'zod';
import { handle, NO_ARGS } from './ipc-register';
import {
  CloneProfileRequestSchema,
  DayZQueryTargetSchema,
  DiscoverOptionsSchema,
  DiscoveryResultSchema,
  ExternalUrlSchema,
  FileDialogOptionsSchema,
  FilesystemPathSchema,
  GameDigTargetSchema,
  HostSchema,
  MAX_PING_BATCH,
  MAX_WORKSHOP_BATCH,
  ModCountSchema,
  NotificationSchema,
  PlayerCountSchema,
  PortSchema,
  PresenceDataSchema,
  QueryAddressResultSchema,
  GameEditionSchema,
  ServerDataSchema,
  ServerLabelSchema,
  SettingsPayloadSchema,
  StoreKeySchema,
  TimeoutMsSchema,
  SnapshotEnvelopeSchema,
  WorkshopIdSchema
} from './types/ipc-schemas';

// Import environment configuration
import { getApiUrls } from './config/environment';
import { setMusicMuted } from './music-mute';

/**
 * Registers all IPC handlers for the main process
 */
export function registerIPCHandlers(): void {
  console.log('🔧 Registering all IPC handlers...');

  // Spotlight: return the featured server ID and join intent, then clear (one-shot)
  handle('get-spotlight-server-id', NO_ARGS, () => {
    const serverId = store.get('lastSpotlightServerId') as number | undefined;
    const joinRequested = store.get('spotlightJoinRequested') as boolean | undefined;
    store.delete('lastSpotlightServerId');
    store.delete('spotlightJoinRequested');
    return { serverId: serverId ?? null, joinRequested: joinRequested ?? false };
  });

  // Window control handlers
  handle('window-minimize', NO_ARGS, () => {
    const win = getMainWindow();
    if (win) {
      win.minimize();
    }
  });

  handle('window-maximize', NO_ARGS, () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  handle('window-close', NO_ARGS, () => {
    const win = getMainWindow();
    if (win) {
      win.close();
    }
  });

  handle('force-quit', NO_ARGS, () => {
    // Force quit the app, bypassing close-to-tray behavior
    app.exit(0);
  });

  handle('restart-app', NO_ARGS, () => {
    // Relaunch the app and quit the current instance
    logToFile('Restarting application...');
    app.relaunch();
    app.exit(0);
  });

  handle('window-toggle-fullscreen', NO_ARGS, () => {
    const win = getMainWindow();
    if (win) {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  handle('window-is-fullscreen', NO_ARGS, () => {
    const win = getMainWindow();
    return win ? win.isFullScreen() : false;
  });

  // Notification handler with validation
  console.log('🔧 Registering show-notification handler...');
  handle('show-notification', z.tuple([NotificationSchema]), (data) => {
    if (Notification.isSupported()) {
      const validData = data;
      const args = process.argv.slice(1);
      const serve = args.some(val => val === '--serve');
      
      // Use launcher icon if no custom icon provided
      const defaultIconPath = serve
        ? path.join(process.cwd(), 'src', 'assets', 'dayz_beans_launcher_256.png')
        : path.join(process.resourcesPath, 'assets', 'dayz_beans_launcher_256.png');

      const notification = new Notification({
        title: validData.title,
        body: validData.body,
        icon: validData.icon || (fs.existsSync(defaultIconPath) ? defaultIconPath : undefined)
      });
      notification.show();
    }
  });

  handle('window-is-maximized', NO_ARGS, () => {
    const win = getMainWindow();
    return win?.isMaximized() ?? false;
  });

  // File/folder dialog handler
  handle('showOpenDialog', z.tuple([FileDialogOptionsSchema]), async (options) => {
    const win = getMainWindow();
    if (!win) {
      return { canceled: true, filePaths: [] };
    }

    try {
      const result = await dialog.showOpenDialog(win, {
        title: options.title || 'Select Folder',
        properties: options.properties || ['openDirectory'],
        defaultPath: options.defaultPath,
        buttonLabel: options.buttonLabel || 'Select'
      });

      return result;
    } catch (error) {
      console.error('Error showing open dialog:', error);
      return { canceled: true, filePaths: [] };
    }
  });

  // Server join handler
  handle('join-server', z.tuple([ServerDataSchema]), async (serverData) => {
    console.log('🎯 IPC Handler: join-server called');

    console.log('📥 Received server data:', {
      name: serverData.name,
      ip: serverData.ip,
      port: serverData.port,
      modCount: serverData.mods?.length || 0
    });

    const { ip, port, name, password, mods, isPromoted, description, trailerUrl, bannerUrl, logoUrl, coverUrl, galleryUrls, discordUrl, websiteUrl } = serverData;
    const edition = editionOf(serverData.edition);
    // Server is premium if it's promoted OR has any owner-editable fields filled
    const isPremium = isPromoted === true || 
      !!(description || trailerUrl || bannerUrl || logoUrl || coverUrl || galleryUrls?.length || discordUrl || websiteUrl);
    let endJoinPhase: (() => void) | undefined;

    try {
      // Update Discord: Connecting (with server info for Join button)
      // Premium servers get their name as the main Discord title
      discordService.setConnecting(name || `${ip}:${port}`, ip, port, isPremium);
      
      console.log(`🔍 Finding DayZ executable (${edition.id})...`);
      const dayZExecutablePath = await findDayZExecutable(edition);
      if (!dayZExecutablePath) {
        console.error('❌ DayZ executable not found');
        discordService.setBrowsingServers(); // Reset on error
        throw new Error(edition.id === 'experimental'
          ? 'DayZ Experimental is not installed. Install it through Steam to join this server.'
          : 'DayZ executable not found. Please set the path in settings.');
      }
      console.log('✅ DayZ executable found:', dayZExecutablePath);

      // Handle mods if present
      if (mods && mods.length > 0) {
        console.log(`📦 Server requires ${mods.length} mods`);
        
        if (!isSteamInitialized() && !ensureSteamInitialized()) {
          console.error('❌ Steam not initialized');
          discordService.setBrowsingServers(); // Reset on error
          throw new Error('Steam is not running. Cannot join server with mods.');
        }
        console.log('✅ Steam is initialized');

        const win = getMainWindow();
        win?.webContents.send('mod-download-status', { status: 'Starting join process...' });

        // Update Discord: Downloading mods (with server info for Join button)
        discordService.setDownloading(mods.length, undefined, name, ip, port, isPremium);
        
        console.log('⬇️ Starting mod download/verification...');
        // Tell the background update sweep to stand down: this join needs the Steam
        // download queue to itself, or the mod it is waiting for queues behind dozens
        // of unrelated ones.
        endJoinPhase = beginJoinPhase();
        // Download and verify all mods
        const verification = await downloadAndVerifyMods(mods);
        console.log('✅ Mods verified, workshop path:', verification.workshopRootPath);

        console.log('🔗 Creating mod junctions...');
        // Create junctions for all mods in the workshop folder
        const junctionDir = await createModJunctions(verification, mods, dayZExecutablePath);
        console.log('✅ Junctions created:', junctionDir);

        win?.webContents.send('mod-download-status', { status: `Created ${mods.length} mod junctions. Launching DayZ...` });
        
        console.log('🎮 Launching DayZ with mods...');
        // Hand Steam's install folders to the launcher so it does not re-derive the
        // workshop root from the default library.
        const dayZProcess = await launchDayZ(serverData, junctionDir, verification);
        console.log('✅ Day(Z) Beans Launchered successfully, PID:', dayZProcess.pid);
        
        // Update Discord: Playing (with server info for Join button)
        // Premium servers get their name as the main Discord title
        discordService.setPlaying(name || `${ip}:${port}`, ip, port, isPremium);
        
        return { success: true, message: 'DayZ is launching with all required mods.', pid: dayZProcess.pid };
      }

      console.log('🎮 Launching DayZ without mods...');
      // No mods, direct launch
      const dayZProcess = await launchDayZ(serverData, '');
      console.log('✅ Day(Z) Beans Launchered successfully, PID:', dayZProcess.pid);
      
      // Update Discord: Playing (with server info for Join button)
      // Premium servers get their name as the main Discord title
      discordService.setPlaying(name || `${ip}:${port}`, ip, port, isPremium);
      
      return { success: true, method: 'direct-launch', pid: dayZProcess.pid };

    } catch (error) {
      console.error('❌ Failed to join server:', error);
      console.error('Error stack:', (error as Error).stack);
      // Reset Discord on error
      discordService.setBrowsingServers();
      const win = getMainWindow();
      win?.webContents.send('mod-download-status', { status: `Error: ${(error as Error).message}`, error: true });
      return { success: false, error: (error as Error).message };
    } finally {
      // Release the download queue whether the join succeeded, failed or was cancelled.
      endJoinPhase?.();
    }
  });

  // Cancel join process handler
  handle('cancel-join-process', NO_ARGS, async () => {
    try {
      console.log('⚠️ Cancelling join process...');
      // Signal our own download/verify + junction loops to stop.
      // NOTE: We intentionally do NOT unsubscribe from Steam Workshop items here.
      // steamworks.js exposes no pause/suspend API — only unsubscribe(), which is a
      // PERMANENT removal applied after the game quits. Unsubscribing every currently
      // downloading item would wipe mods the user subscribed to independently of this
      // join. Any in-flight Steam download simply continues in the background; the mod
      // stays subscribed, which is the desired outcome.
      cancelDownloadProcess();

      // Reset Discord presence
      discordService.setBrowsingServers();
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('mod-download-status', {
          status: 'Download cancelled by user',
          error: true
        });
      }
      return { success: true, message: 'Join process cancelled' };
    } catch (error) {
      console.error('Failed to cancel join process:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Kill DayZ processes handler
  handle('kill-dayz-processes', NO_ARGS, async () => {
    try {
      console.log('🔪 Killing DayZ processes...');
      killDayZProcesses();
      return { success: true, message: 'DayZ processes killed' };
    } catch (error) {
      console.error('Failed to kill DayZ processes:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Check if DayZ is currently running
  handle('is-dayz-running', NO_ARGS, async () => {
    try {
      const { isDayZRunning } = await import('./platform-utils');
      const isRunning = await isDayZRunning();
      console.log('🎮 DayZ running check:', isRunning);
      return { success: true, isRunning };
    } catch (error) {
      console.error('Failed to check if DayZ is running:', error);
      return { success: false, isRunning: false, error: (error as Error).message };
    }
  });

  // Ping server handler (legacy ICMP - fallback)
  handle('ping-server', z.tuple([HostSchema]), async (host) => {
    return await pingServer(host);
  });

  // GameDig A2S ping handler - more reliable for game servers
  // Uses queryPort (Steam query port) instead of game port
  handle('ping-server-gamedig', z.tuple([HostSchema, PortSchema, TimeoutMsSchema.optional()]), async (ip, queryPort, timeout) => {
    return await pingServerGameDig(ip, queryPort, timeout);
  });

  // Batch ping multiple servers using GameDig
  handle(
    'ping-servers-gamedig',
    z.tuple([
      z.array(GameDigTargetSchema).max(MAX_PING_BATCH),
      z.number().int().min(1).max(64).optional(),
      TimeoutMsSchema.optional()
    ]),
    async (servers, concurrency, timeout) => {
    const results = await pingServersGameDig(servers, concurrency, timeout);
    // Convert Map to array for IPC serialization
    return Array.from(results.entries()).map(([serverId, result]) => ({
      serverId,
      ...result
    }));
  });

  // Get server info (includes player count) using GameDig
  handle('get-server-info-gamedig', z.tuple([HostSchema, PortSchema, TimeoutMsSchema.optional()]), async (ip, queryPort, timeout) => {
    return await getServerInfoGameDig(ip, queryPort, timeout);
  });

  // Direct Connect: DayZ servers on this PC and, when the player turns it on, the local
  // network. Takes no host: see local-server-discovery.ts for what gets scanned.
  handle('discover-local-servers', z.tuple([DiscoverOptionsSchema]), async (options) => {
    const result = await discoverLocalServers(options);
    // Checked on the way out as well: these values come from whatever answered on a port.
    const checked = DiscoveryResultSchema.safeParse(result);
    if (!checked.success) {
      logToFile(`[Direct Connect] Discovery result rejected: ${checked.error.issues[0]?.message}`);
      return { servers: [], scannedPorts: [], lanScanned: options.lan, tookMs: result.tookMs };
    }
    return checked.data;
  });

  // Direct Connect: the server at one address the player typed (at most six query ports).
  handle('query-dayz-server', z.tuple([DayZQueryTargetSchema]), async (target) => {
    const result = await queryAddress(target);
    const checked = QueryAddressResultSchema.safeParse(result);
    if (!checked.success) {
      logToFile(`[Direct Connect] Query result rejected: ${checked.error.issues[0]?.message}`);
      return { ok: false, reason: 'timeout', triedPorts: [] };
    }
    return checked.data;
  });

  // Clear ping cache
  handle('clear-ping-cache', NO_ARGS, () => {
    clearPingCache();
    return { success: true };
  });

  // Steam Workshop IPC handlers
  handle('steam-is-initialized', NO_ARGS, () => {
    return isSteamInitialized();
  });

  // Like steam-is-initialized, but retries init if it failed at startup (Linux: launcher
  // started before Steam). Use this before download/subscribe flows.
  handle('steam-ensure-initialized', NO_ARGS, () => {
    return ensureSteamInitialized();
  });

  handle('steam-is-running', NO_ARGS, async () => {
    try {
      const { isSteamRunning } = await import('./platform-utils');
      return await isSteamRunning();
    } catch (error) {
      console.error('Failed to check if Steam is running:', error);
      return false;
    }
  });

  // Why Steam could not be reached, in a form the "Steam not detected" modal can
  // show the player and they can copy into a support thread. Deliberately not
  // gated behind a debug flag: the modal is a hard block, so the one moment the
  // information is needed is the one moment the rest of the UI is unreachable.
  handle('steam-get-diagnostics', NO_ARGS, async () => {
    try {
      const { collectSteamDiagnostics, formatDiagnosticsReport } = await import('./steam-diagnostics');
      const diagnostics = await collectSteamDiagnostics();
      return {
        success: true,
        diagnostics,
        // Redacted (home directory and username stripped) — this string is written
        // for pasting in public.
        report: formatDiagnosticsReport(diagnostics, true),
      };
    } catch (error) {
      logToFile(`Failed to collect Steam diagnostics: ${error}`);
      return { success: false, error: (error as Error).message };
    }
  });

  // Reveal app-debug.log in the OS file manager. Players cannot be expected to
  // navigate to "%APPDATA%\\Day(Z) Beans Launcher" by hand.
  handle('open-log-folder', NO_ARGS, async () => {
    try {
      const logPath = getLogFilePath();
      if (fs.existsSync(logPath)) {
        shell.showItemInFolder(logPath);
      } else {
        // No log written yet — open the containing folder rather than failing.
        await shell.openPath(path.dirname(logPath));
      }
      return { success: true, path: logPath };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle('steam-detect-installation', NO_ARGS, async () => {
    try {
      const { detectSteamInstallation } = await import('./platform-utils');
      return await detectSteamInstallation();
    } catch (error) {
      console.error('Failed to detect Steam installation:', error);
      // Return the full SteamInstallation shape the renderer selector expects
      return {
        type: 'none',
        command: '',
        supportsNativeAPI: false,
        isInstalled: false,
        isRunning: false,
        installPath: null
      };
    }
  });

  handle('is-mod-installed-on-disk', z.tuple([WorkshopIdSchema]), async (workshopId) => {
    try {
      const { isModInstalledOnDisk } = await import('./platform-utils');
      return await isModInstalledOnDisk(workshopId);
    } catch (error) {
      console.error('Failed to check mod installation on disk:', error);
      return false;
    }
  });

  handle('get-installed-mods-from-disk', NO_ARGS, async () => {
    try {
      const { getInstalledModsFromDisk } = await import('./platform-utils');
      return await getInstalledModsFromDisk();
    } catch (error) {
      console.error('Failed to get installed mods from disk:', error);
      return [];
    }
  });

  handle('steam-get-user-info', NO_ARGS, () => {
    return getSteamUserInfo();
  });

  handle('steam-get-subscribed-items', NO_ARGS, async () => {
    return await getSubscribedItems();
  });

  // Fast mode - only local data, no network calls (~50ms for 50 mods)
  handle('steam-get-subscribed-items-fast', NO_ARGS, async () => {
    return await getSubscribedItemsFast();
  });

  handle('steam-subscribe-item', z.tuple([WorkshopIdSchema]), async (publishedFileId) => {
    return await subscribeToItem(publishedFileId);
  });

  handle('steam-unsubscribe-item', z.tuple([WorkshopIdSchema]), async (publishedFileId) => {
    return await unsubscribeFromItem(publishedFileId);
  });

  handle('steam-get-item-download-info', z.tuple([WorkshopIdSchema]), async (publishedFileId) => {
    return await getItemDownloadInfo(publishedFileId);
  });

  handle('is-mod-installed', z.tuple([WorkshopIdSchema]), async (publishedFileId) => {
    return await isModInstalled(publishedFileId);
  });

  handle('steam-get-item-install-info', z.tuple([WorkshopIdSchema]), async (publishedFileId) => {
    return await getItemInstallInfo(publishedFileId);
  });

  handle('steam-get-workshop-item-details', z.tuple([WorkshopIdSchema]), async (publishedFileId) => {
    return await getWorkshopItemDetails(publishedFileId);
  });

  handle('steam-force-download', z.tuple([WorkshopIdSchema]), async (publishedFileId) => {
    return await forceDownloadItem(publishedFileId);
  });

  // Freshness for one mod: installed AND not stale AND nothing in flight. The renderer
  // used to reimplement this from raw state bits and timestamps in three places.
  // `queryWorkshop: false` answers from Steam's local flags only. A progress poll running
  // once a second must pass it — the workshop lookup is a network round trip.
  handle('steam-get-mod-update-status', z.tuple([WorkshopIdSchema, z.boolean().optional()]), async (publishedFileId, queryWorkshop) => {
    return await getModUpdateStatus(publishedFileId, { queryWorkshop: queryWorkshop !== false });
  });

  handle('steam-get-mod-update-statuses', z.tuple([z.array(WorkshopIdSchema).max(MAX_WORKSHOP_BATCH)]), async (publishedFileIds) => {
    return { success: true, statuses: await getModUpdateStatuses(publishedFileIds) };
  });

  // Check every subscribed mod and carry the updates through. Also runs at startup.
  handle('mods-sweep-updates', z.tuple([]), async () => {
    return await sweepModUpdates();
  });

  handle('steam-get-mod-sizes', z.tuple([z.array(WorkshopIdSchema).max(MAX_WORKSHOP_BATCH)]), async (workshopIds) => {
    return await getModSizes(workshopIds);
  });

  // Batch fetch workshop item details from Steam API
  handle('steam-get-workshop-items-batch', z.tuple([z.array(WorkshopIdSchema).max(MAX_WORKSHOP_BATCH)]), async (publishedFileIds) => {
    return await getWorkshopItemDetailsBatch(publishedFileIds);
  });

  // Open external URL handler
  // Only allow http/https/mailto — block file://, javascript:, and other schemes that
  // a compromised renderer could abuse to run local files or scripts.
  handle('open-external', z.tuple([ExternalUrlSchema]), async (url) => {
    try {
      // Web/mail links and the Steam Workshop links only (see external-url.ts). Workshop
      // buttons pass steam://url/... links, which the old http/https/mailto-only list
      // refused, so every "open in Workshop" did nothing.
      if (!isAllowedExternalUrl(url)) {
        logToFile(`[open-external] Blocked: ${url.slice(0, 200)}`);
        return { success: false, error: 'URL not allowed' };
      }

      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Open mod folder in file explorer
  handle('open-mod-folder', z.tuple([WorkshopIdSchema]), async (workshopId) => {
    try {
      const workshopPath = await getActualDayZWorkshopPath();
      const modPath = path.join(workshopPath, workshopId);

      if (fs.existsSync(modPath)) {
        await shell.openPath(modPath);
        return { success: true };
      } else {
        return { success: false, error: `Mod folder not found: ${modPath}` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Environment configuration handler
  handle('get-api-urls', NO_ARGS, () => {
    return getApiUrls();
  });

  // DayZ installation verification handler
  handle('verify-dayz-installation', NO_ARGS, async () => {
    try {
      console.log('🔍 Verifying DayZ installation...');
      const dayZExecutablePath = await findDayZExecutable();
      
      if (dayZExecutablePath) {
        console.log('✅ DayZ executable found:', dayZExecutablePath);
        return { 
          isInstalled: true, 
          executablePath: dayZExecutablePath,
          needsConfiguration: false 
        };
      } else {
        console.log('❌ DayZ executable not found');
        // Log the current settings path for debugging
        const currentPath = store.get('settings.dayzPath');
        console.log('🔧 Current DayZ path in settings:', currentPath);
        const leftoverFolder = await findUninstalledDayZFolder();
        return { 
          isInstalled: false, 
          error: leftoverFolder
            ? `DayZ is not installed in Steam (only leftover files remain in ${leftoverFolder}).`
            : 'DayZ executable not found. Please set the path in settings.',
          needsConfiguration: true,
          reason: leftoverFolder ? 'uninstalled' : 'not-found',
        };
      }
    } catch (error) {
      console.error('❌ Error verifying DayZ installation:', error);
      return { 
        isInstalled: false, 
        error: (error as Error).message || 'Unknown verification error',
        needsConfiguration: true 
      };
    }
  });

  // Which DayZ clients are installed, as executable paths (null when not found). The
  // servers page shows its Stable / Experimental switch only when Experimental is here.
  // One edition per call: the join gate only ever needs Experimental, and a stable
  // search can fall through to a slow PowerShell scan for nothing.
  handle('find-dayz-edition', z.tuple([z.enum(['stable', 'experimental'])]), async (edition) =>
    findDayZExecutable(GAME_EDITIONS[edition]));

  // DayZ path verification handler (with specific path)
  handle('verify-dayz-path', z.tuple([FilesystemPathSchema]), async (dayzPath) => {
    try {
      console.log('🔍 Verifying specific DayZ path:', dayzPath);
      
      if (!dayzPath) {
        console.log('❌ No DayZ path provided');
        return { 
          isInstalled: false, 
          error: 'No DayZ path provided',
          needsConfiguration: true 
        };
      }

      // Use the centralized validation function
      const validation = await validateAndFixDayZPath(dayzPath);
      
      if (validation.valid && validation.correctedPath) {
        const executablePath = path.join(validation.correctedPath, 'DayZ_BE.exe');
        console.log('✅ DayZ_BE.exe found at:', executablePath);
        
        // Return the corrected path so the UI can update if needed
        return { 
          isInstalled: true, 
          executablePath: executablePath,
          correctedPath: validation.correctedPath,
          needsConfiguration: false 
        };
      } else {
        console.log('❌ DayZ path validation failed:', validation.error);
        return { 
          isInstalled: false, 
          error: validation.error || 'DayZ_BE.exe not found',
          needsConfiguration: true 
        };
      }
    } catch (error) {
      console.error('❌ Error verifying DayZ path:', error);
      return { 
        isInstalled: false, 
        error: (error as Error).message || 'Unknown verification error',
        needsConfiguration: true 
      };
    }
  });

  // Lists the DayZ profiles that already exist on disk, so the user can pick the profile
  // the game was already using instead of us inventing a new one. Launching with a -name
  // the game has never seen makes DayZ create a fresh profile: keybinds, gameplay and video
  // settings all look "reset". Same for a -profiles directory the game does not use.
  handle('list-dayz-profiles', NO_ARGS, async () => {
    try {
      const { defaultProfilesPath, profiles } = await scanDayZProfiles();
      return { success: true, defaultProfilesPath, profiles };
    } catch (error) {
      console.error('❌ Error listing DayZ profiles:', error);
      return { success: false, defaultProfilesPath: '', profiles: [], error: (error as Error).message };
    }
  });

  // Copies an existing profile under a new name. Changing the in-game name means changing the
  // profile name, and an unknown -name gives the player a profile with default settings — so
  // clone the files first and keep the keybinds, control presets and video settings.
  handle('clone-dayz-profile', z.tuple([CloneProfileRequestSchema]), async (payload) => {
    try {
      const { sourceName, sourceDirectory, newName } = payload;
      const result = await cloneDayZProfile(sourceName, sourceDirectory ?? '', newName);
      if (result.success) {
        console.log(`✅ Cloned DayZ profile "${sourceName}" → "${newName}" (${result.copiedFiles?.length} files)`);
      } else {
        console.log(`⚠️ Could not clone DayZ profile: ${result.error}`);
      }
      return result;
    } catch (error) {
      console.error('❌ Error cloning DayZ profile:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // The folder the profile files actually live in. "Game Settings Path" is empty for most
  // users — that is the recommended setting — so this is what resolves the empty value into
  // the concrete folder the game and the picker use.
  handle('resolve-profiles-folder', NO_ARGS, async () => {
    try {
      const { path: folder, exists } = await resolveProfilesFolder();
      return { success: true, path: folder, exists };
    } catch (error) {
      return { success: false, path: '', exists: false, error: (error as Error).message };
    }
  });

  // Opens the folder the profile files live in, so the user can see what the picker sees —
  // including a profile they just cloned.
  handle('open-profiles-folder', NO_ARGS, async () => {
    try {
      const { path: folder, exists } = await resolveProfilesFolder();
      if (!exists) {
        return { success: false, path: folder, error: `Folder not found: ${folder}` };
      }
      const openError = await shell.openPath(folder);
      if (openError) {
        return { success: false, path: folder, error: openError };
      }
      return { success: true, path: folder };
    } catch (error) {
      return { success: false, path: '', error: (error as Error).message };
    }
  });

  // Reports a profile DayZ created since the last launch — what an in-game rename looks like
  // on disk — so the launcher can offer to follow it instead of forcing the old -name back.
  handle('check-dayz-profile-drift', NO_ARGS, async () => {
    try {
      const profile = await detectProfileDrift();
      return { success: true, profile: profile ?? null };
    } catch (error) {
      console.error('❌ Error checking DayZ profile drift:', error);
      return { success: false, profile: null, error: (error as Error).message };
    }
  });

  // Save settings handler (sync NgRx to electron-store)
  handle('save-settings', z.tuple([SettingsPayloadSchema]), async (settings) => {
    try {
      console.log('💾 Saving settings to electron-store:', settings);
      
      if (!settings) {
        console.log('❌ No settings provided');
        return false;
      }

      // Save each setting to electron-store
      // An empty path never overwrites a saved one. The renderer starts with '' and syncs
      // its whole settings object at startup, before detection reports back, so writing
      // it through erased the path detection had just found. An empty field already
      // means "detect it" to findDayZExecutable, which falls back to detection whenever
      // the saved path stops validating.
      // Clearing is its own flag so the startup sync's '' can never pass for it.
      if (settings.clearDayzPath) {
        store.delete('settings.dayzPath');
        console.log('💾 DayZ path cleared, detection takes over');
      } else if (typeof settings.dayzPath === 'string' && settings.dayzPath.trim()) {
        store.set('settings.dayzPath', settings.dayzPath);
        console.log('💾 DayZ path saved to electron-store:', settings.dayzPath);
      }
      if (typeof settings.dayzExpPath === 'string' && settings.dayzExpPath.trim()) {
        store.set('settings.dayzExpPath', settings.dayzExpPath);
      }
      
      if (settings.launchParameters !== undefined) {
        store.set('settings.launchParameters', settings.launchParameters);
      }

      // Read by the splash, which plays before the renderer has its settings
      if (settings.musicIntro !== undefined) {
        store.set('settings.musicIntro', settings.musicIntro);
      }
      if (settings.musicVolume !== undefined) {
        store.set('settings.musicVolume', settings.musicVolume);
      }
      if (settings.musicMuted !== undefined) {
        setMusicMuted(settings.musicMuted, 'renderer');
      }
      
      if (settings.profileName !== undefined) {
        store.set('settings.profileName', settings.profileName);
      }
      
      if (settings.windowMode !== undefined) {
        store.set('settings.windowMode', settings.windowMode);
      }
      
      if (settings.serverPassword !== undefined) {
        store.set('settings.serverPassword', settings.serverPassword);
      }
      
      if (settings.noPause !== undefined) {
        store.set('settings.noPause', settings.noPause);
      }

      if (settings.profilesPath !== undefined) {
        store.set('settings.profilesPath', settings.profilesPath);
      }
      
      if (settings.autoLaunch !== undefined) {
        store.set('settings.autoLaunch', settings.autoLaunch);
      }
      
      if (settings.minimizeToTray !== undefined) {
        store.set('settings.minimizeToTray', settings.minimizeToTray);
      }
      
      if (settings.startMinimized !== undefined) {
        store.set('settings.startMinimized', settings.startMinimized);
      }
      
      if (settings.closeToTray !== undefined) {
        store.set('settings.closeToTray', settings.closeToTray);
      }
      
      if (settings.enableNotifications !== undefined) {
        store.set('settings.enableNotifications', settings.enableNotifications);
      }
      
      if (settings.autoUpdate !== undefined) {
        store.set('settings.autoUpdate', settings.autoUpdate);
      }
      
      if (settings.checkForUpdatesOnStartup !== undefined) {
        store.set('settings.checkForUpdatesOnStartup', settings.checkForUpdatesOnStartup);
      }

      if (settings.hideDiscordServerDetails !== undefined) {
        // Read back by discord-service.buildPresence to hide the specific server
        store.set('settings.hideDiscordServerDetails', settings.hideDiscordServerDetails);
      }

      if (settings.crashReporting !== undefined) {
        // Read back by electron/sentry.ts on the NEXT launch. The main-process SDK
        // initializes before any window exists, so it cannot be reconfigured live;
        // the settings screen tells the user a restart is required.
        store.set('settings.crashReporting', settings.crashReporting);
      }

      console.log('✅ Settings successfully saved to electron-store');
      return true;
    } catch (error) {
      console.error('❌ Error saving settings to electron-store:', error);
      return false;
    }
  });

  // System tray and auto-start handlers are now in main.ts to avoid circular dependency

  // Discord Rich Presence IPC handlers
  handle('discord-update-presence', z.tuple([PresenceDataSchema]), async (data) => {
    try {
      const success = await discordService.updatePresence(data);
      return { success };
    } catch (error) {
      console.error('Error updating Discord presence:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  handle('discord-set-browsing', NO_ARGS, async () => {
    try {
      const success = await discordService.setBrowsingServers();
      return { success };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(
    'discord-set-viewing-server',
    z.tuple([
      ServerLabelSchema,
      HostSchema.optional(),
      PortSchema.optional(),
      PlayerCountSchema.optional(),
      PlayerCountSchema.optional(),
      z.boolean().optional()
    ]),
    async (serverName, serverIp, serverPort, playerCount, maxPlayers, isPremiumServer) => {
    try {
      const success = await discordService.setViewingServer(serverName, serverIp, serverPort, playerCount, maxPlayers, isPremiumServer);
      return { success };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(
    'discord-set-connecting',
    z.tuple([ServerLabelSchema.optional(), HostSchema.optional(), PortSchema.optional(), z.boolean().optional()]),
    async (serverName, serverIp, serverPort, isPremiumServer) => {
    try {
      const success = await discordService.setConnecting(serverName, serverIp, serverPort, isPremiumServer);
      return { success };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(
    'discord-set-downloading',
    z.tuple([
      ModCountSchema.optional(),
      z.number().min(0).max(100).optional(),
      ServerLabelSchema.optional(),
      HostSchema.optional(),
      PortSchema.optional(),
      z.boolean().optional()
    ]),
    async (modCount, downloadProgress, serverName, serverIp, serverPort, isPremiumServer) => {
    try {
      const success = await discordService.setDownloading(modCount, downloadProgress, serverName, serverIp, serverPort, isPremiumServer);
      return { success };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(
    'discord-set-playing',
    z.tuple([
      ServerLabelSchema.optional(),
      HostSchema.optional(),
      PortSchema.optional(),
      z.boolean().optional(),
      PlayerCountSchema.optional(),
      PlayerCountSchema.optional()
    ]),
    async (serverName, serverIp, serverPort, isPremiumServer, playerCount, maxPlayers) => {
    try {
      const success = await discordService.setPlaying(serverName, serverIp, serverPort, isPremiumServer, playerCount, maxPlayers);
      return { success };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle('discord-set-managing-mods', z.tuple([ModCountSchema.optional()]), async (modCount) => {
    try {
      const success = await discordService.setManagingMods(modCount);
      return { success };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle('discord-clear-presence', NO_ARGS, async () => {
    try {
      const success = await discordService.clearPresence();
      return { success };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle('discord-is-connected', NO_ARGS, () => {
    return discordService.isDiscordConnected();
  });

  // =============================================================================
  // App Suspension Handlers
  // =============================================================================

  handle('get-suspension-state', NO_ARGS, () => {
    return getSuspensionState();
  });

  // =============================================================================
  // Generic Store Data Handlers
  // Backing store for electronAPI.setStoreData / getStoreData / deleteStoreData
  // (used e.g. by the version-upgrade changelog flow in app.component).
  // =============================================================================

  // =============================================================================
  // Offline snapshot (see snapshot-store.ts for why this is its own file rather
  // than a key in the shared electron-store config)
  // =============================================================================

  handle('snapshot-write', z.tuple([SnapshotEnvelopeSchema]), (envelope) =>
    writeSnapshot(snapshotFs, snapshotPath(), envelope)
  );

  handle('snapshot-read', NO_ARGS, () => readSnapshot(snapshotFs, snapshotPath()));

  handle('snapshot-clear', NO_ARGS, () => clearSnapshot(snapshotFs, snapshotPath()));

  handle('snapshot-stat', NO_ARGS, () => statSnapshot(snapshotFs, snapshotPath()));

  handle('setStoreData', z.tuple([StoreKeySchema, z.unknown()]), (key, value) => {
    try {
      store.set(key, value);
      return { success: true };
    } catch (error) {
      console.error('Failed to set store data:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  handle('getStoreData', z.tuple([StoreKeySchema]), (key) => {
    try {
      return store.get(key) ?? null;
    } catch (error) {
      console.error('Failed to get store data:', error);
      return null;
    }
  });

  // The anonymous install id. Owned here rather than in renderer localStorage so it
  // survives a cache wipe and so the main-process update check can send it too.
  // The optional argument is the renderer's legacy localStorage id, adopted only when
  // nothing is stored yet — see anonymous-id.ts.
  handle('get-anonymous-id', z.tuple([z.string().optional()]), (legacyId) => {
    return getAnonymousId(legacyId);
  });

  handle('deleteStoreData', z.tuple([StoreKeySchema]), (key) => {
    try {
      store.delete(key as any);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete store data:', error);
      return { success: false, error: (error as Error).message };
    }
  });
}

/** Where the offline snapshot lives. Resolved lazily: app paths are not ready at import time. */
function snapshotPath(): string {
  return path.join(app.getPath('userData'), SNAPSHOT_FILENAME);
}

/**
 * The real filesystem, adapted to the narrow interface snapshot-store depends on so
 * that its logic can be unit-tested against a fake.
 */
const snapshotFs: SnapshotFs = {
  writeFile: (file, data, encoding) => fs.promises.writeFile(file, data, encoding),
  readFile: (file, encoding) => fs.promises.readFile(file, encoding),
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (file) => fs.promises.unlink(file),
  stat: (file) => fs.promises.stat(file)
};
