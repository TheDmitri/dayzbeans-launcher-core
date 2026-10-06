import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';

import { DayZServer } from './types/models/server.model';
import {
  isWindows,
  isLinux,
  killAllDayZProcesses,
  getDayZInstallDirCandidates,
  getLaunchCommand,
  pathExists,
  readDayZInstallDirName,
} from './platform-utils';
import { dayZFoldersUnder, PathSeparator, GAME_EDITIONS, GameEdition, editionOf } from './dayz-install-locator';
import { logToFile } from './logger';
import { createWorkshopIdSymlinks, verifyModLinks, getWindowsModLinkNames, linkLocalServerMods, type ModVerificationResult } from './mod-management';
import { resolveLocalServerMods } from './local-servers/local-server-discovery';
import { recordProfileSnapshot } from './dayz-profiles';
import { e2eHooks } from './e2e-hooks';

const store = new Store();

/**
 * Splits a user-typed launch parameter string into argv entries.
 *
 * Whitespace separates parameters, except inside double quotes, so a value such as
 * `-profiles="C:\Users\John Doe\Documents\DayZ"` survives as one argument. The quotes
 * themselves are stripped — spawn() re-quotes each argv entry for the platform.
 */
/**
 * Redact secrets from an argv list before it is logged.
 *
 * `-password=` carries the server password the player typed, or the one a server
 * owner distributes to their community. It used to go to the console verbatim as
 * part of `args.join(' ')`. On a packaged Windows build stdout goes nowhere, so
 * that was survivable by accident rather than by design -- it was plainly visible
 * on Linux, and the moment this file follows the rest of the codebase onto
 * `logToFile` it would land in app-debug.log and in the diagnostics blob players
 * paste into support threads.
 *
 * Redacting at the log call rather than logging a hand-built subset means a
 * future argument carrying a secret has to be added here explicitly, instead of
 * silently appearing in a log because someone appended to `args`.
 */
const REDACTED_ARGS = ['-password'];

export function redactArgsForLog(args: string[]): string {
  return args
    .map((arg) => {
      const secret = REDACTED_ARGS.find((name) => arg.startsWith(`${name}=`));
      return secret ? `${secret}=<redacted>` : arg;
    })
    .join(' ');
}

export function splitLaunchParams(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasContent = false;

  for (const char of raw) {
    if (char === '"') {
      inQuotes = !inQuotes;
      hasContent = true;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (hasContent) {
        args.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }

  if (hasContent) {
    args.push(current);
  }

  return args.filter(a => a.length > 0);
}

/**
 * Kills any running DayZ processes (async to avoid blocking main process)
 * Uses platform-specific commands
 */
export async function killDayZProcesses(): Promise<void> {
  console.log('🔪 Killing DayZ processes...');
  await killAllDayZProcesses();
  console.log('✅ DayZ processes killed');
}

/**
 * Refuse to launch unless every required mod is present and current.
 *
 * DayZ reports neither problem usefully: a `-mod=@123` entry whose link is dangling is
 * loaded as nothing, and a stale mod is refused by the server with a message that tells
 * the player nothing about which mod or why. Both used to be reachable — the download
 * wait returned as soon as Steam said "installed", which is already true of a mod that
 * merely needs an update. Failing here, by name, costs the player a retry instead of a
 * confusing rejection at the connect screen.
 *
 * `skipped` are the mods the download phase could not subscribe to. It skips them so the
 * other mods still download (a retry then only waits on those), but the server needs
 * them too, so they fail the launch here under their real cause: without this check they
 * surfaced as missing links, blamed on Steam not running.
 */
async function assertModsReadyToLaunch(
  mods: Array<{ workshopId: number; name: string }>,
  dayZExecutablePath: string,
  skipped: string[] = []
): Promise<void> {
  if (skipped.length > 0) {
    console.error('❌ Mods Steam would not subscribe to:', skipped);
    throw new Error(
      `Steam did not subscribe to ${skipped.length} required mod(s): ${skipped.join(', ')}. ` +
      `Subscribe on the Steam Workshop and try again. A mod removed from the Workshop or made private blocks this server until it changes its mod list.`
    );
  }

  const { ok, broken } = await verifyModLinks(mods, dayZExecutablePath);
  if (!ok) {
    const names = broken.map(b => b.name || b.workshopId).join(', ');
    console.error('❌ Mod links missing or broken before launch:', broken);
    throw new Error(
      `${broken.length} mod link(s) could not be created: ${names}. ` +
      `Check that Steam is running and the mods are installed, then try again.`
    );
  }

  const { getModUpdateStatuses } = await import('./steam-service');
  const statuses = await getModUpdateStatuses(mods.map(m => m.workshopId.toString()), { queryWorkshop: false });

  // 'steam-unavailable' is not evidence of staleness — do not block a launch on a Steam
  // API that went away after the download phase already succeeded.
  const stale = statuses.filter(status => status.success && !status.isUpToDate);

  if (stale.length > 0) {
    const names = stale
      .map(status => mods.find(m => m.workshopId.toString() === status.workshopId)?.name || status.workshopId)
      .join(', ');
    console.error('❌ Mods still not current before launch:', stale.map(s => `${s.workshopId}:${s.reason}`));
    throw new Error(
      `${stale.length} mod(s) are still downloading or out of date: ${names}. ` +
      `Wait for Steam to finish and try again.`
    );
  }

  console.log(`✅ Pre-launch check passed: ${mods.length} mods linked and current`);
}

/**
 * Spawns the game (or `steam -applaunch`). The e2e suite replaces it with a fake that
 * records the command line instead of starting DayZ (see e2e-hooks.ts).
 */
function spawnGame(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (e2eHooks?.fakes.spawnGame) {
    return e2eHooks.fakes.spawnGame({ command, args, cwd: options.cwd?.toString() }) as ChildProcess;
  }
  return spawn(command, args, options);
}

/**
 * Launches DayZ client with specified server and mods
 *
 * `verification` carries the install folders Steam reported during the download phase.
 * This function used to ignore it and re-derive the workshop root from the default Steam
 * install, which is wrong for anyone whose library lives elsewhere.
 */
export async function launchDayZ(
  serverData: any,
  _junctionDir: string,
  verification?: ModVerificationResult
): Promise<any> {
  const { ip, port, password } = serverData;
  const edition = editionOf(serverData.edition);
  const dayZExecutablePath = await findDayZExecutable(edition);

  if (!dayZExecutablePath) {
    throw new Error(edition.id === 'experimental'
      ? 'DayZ Experimental is not installed. Install it through Steam to join this server.'
      : 'DayZ executable not found. Please set the path in settings.');
  }

  // Kill any existing DayZ processes before launching (Windows only)
  // On Linux, pgrep is too aggressive and kills unrelated processes
  if (isWindows) {
    console.log('🔪 Killing any existing DayZ processes...');
    await killDayZProcesses();
    
    // Small delay to ensure processes are fully terminated
    await new Promise(resolve => setTimeout(resolve, 300));
  } else {
    console.log('🐧 Linux: Skipping process kill (Steam will handle it)');
  }

  const dayzRoot = path.dirname(dayZExecutablePath);

  const args = [
    `-connect=${ip}`,
    `-port=${port}`,
  ];

  const modsWithIds: Array<{ workshopId: number; name: string }> = (serverData.mods || []).map((mod: any) => ({
    workshopId: mod.workshopId || mod.steamWorkshopId,
    name: mod.name,
  }));

  const modEntries: string[] = [];

  if (serverData.mods && serverData.mods.length > 0) {
    let modList: string;
    
    if (isLinux) {
      // Linux: Use @workshopId format (symlinks created directly in DayZ folder)
      modList = modsWithIds
        .map(mod => `@${mod.workshopId}`)
        .join(';');
      
      // Create @workshopid symlinks directly in DayZ folder. Prefer the folders Steam
      // reported during verification; only fall back to probing the libraries when this
      // is a launch that never went through the download phase.
      let workshopPath = verification?.workshopRootPath;
      if (!workshopPath) {
        const { getActualDayZWorkshopPath } = await import('./platform-utils');
        workshopPath = await getActualDayZWorkshopPath();
      }

      await createWorkshopIdSymlinks(workshopPath, modsWithIds, dayZExecutablePath, verification?.folders);
    } else {
      // Windows: junctions in the !dzbl folder, named "@<title>_<workshopId>". The names
      // are read back from disk by workshop id rather than rebuilt from the title here —
      // the junctions were created moments ago by createModJunctions, and a -mod= entry
      // naming a folder that does not exist loads no mod and reports nothing.
      const linkNames = await getWindowsModLinkNames(modsWithIds, dayZExecutablePath);
      modList = modsWithIds
        .map(mod => `!dzbl\\${linkNames.get(mod.workshopId.toString())}`)
        .join(';');
    }
    
    modEntries.push(modList);
  }

  // Mods of a server on this PC that are not on the Workshop, when the player chose to
  // load them. The request only names the server; the folders come from the discovery
  // module, which refuses a key for any other server.
  if (typeof serverData.localServerKey === 'string' && serverData.localServerKey) {
    const folders = await resolveLocalServerMods(serverData.localServerKey, ip, port);
    modEntries.push(...await linkLocalServerMods(folders, dayZExecutablePath));
  }

  if (modEntries.length > 0) {
    const modList = modEntries.join(';');
    args.push(`-mod=${modList}`);
    console.log(`Adding mods: ${modList}`);
  }

  // Determine the password to use (settings password overrides server password)
  const serverPassword = store.get('settings.serverPassword', '');
  const effectivePassword = (serverPassword && typeof serverPassword === 'string' && serverPassword.trim())
    ? serverPassword.trim()
    : (password && password.trim()) ? password.trim() : null;
  
  if (effectivePassword) {
    args.push(`-password=${effectivePassword}`);
  }

  // Add custom launch parameters from settings.
  // Key is `settings.launchParameters` — the same key the renderer writes through
  // `save-settings`. It used to be read as `settings.launchParams`, which never existed,
  // so user-supplied parameters were silently dropped.
  const customParams = store.get('settings.launchParameters', '');
  const customParamList = (typeof customParams === 'string') ? splitLaunchParams(customParams) : [];
  if (customParamList.length > 0) {
    args.push(...customParamList);
  }

  // Add profile name if set
  const profileName = store.get('settings.profileName', '');
  if (profileName && typeof profileName === 'string' && profileName.trim()) {
    args.push(`-name=${profileName.trim()}`);
  }

  // Add profiles path (game settings directory)
  // On Linux/Proton: don't pass -profiles — DayZ uses its Proton prefix path automatically.
  // Passing a native Linux path breaks because Wine can't resolve it correctly.
  //
  // When the user leaves this empty we pass NOTHING and let the engine pick its own
  // default. We used to synthesise `os.homedir()/Documents/DayZ`, which is wrong whenever
  // the Documents known folder is redirected (OneDrive backup, Documents moved to another
  // drive). The game then wrote to a different directory than it uses on its own, and every
  // in-game setting looked "reset" compared to launching through Steam or DZSA.
  if (!isLinux) {
    const profilesPath = store.get('settings.profilesPath', '') as string;
    if (profilesPath && typeof profilesPath === 'string' && profilesPath.trim()) {
      args.push(`-profiles=${profilesPath.trim()}`);
    }
  }

  // Add window mode if enabled
  const windowMode = store.get('settings.windowMode', false);
  if (windowMode) {
    args.push('-window');
  }

  // Add default parameters if no custom params are set
  if (customParamList.length === 0) {
    args.push('-skipIntro', '-noSplash');
  }
  
  // noPause setting: when true, add -noPause flag; when false, don't add it
  // Default behavior (false) means the game will pause when alt-tabbed
  const noPause = store.get('settings.noPause', false);
  if (noPause) {
    args.push('-noPause');
  }

  // Snapshot the profiles on disk before the game runs. Renaming yourself in the DayZ main
  // menu creates a new profile, which we would otherwise override with the pinned -name on
  // the next launch — the drift check compares against this snapshot and offers to follow it.
  await recordProfileSnapshot();

  // Last gate before the game starts. Everything above is preparation; this is the only
  // place that confirms the preparation worked.
  if (modsWithIds.length > 0) {
    await assertModsReadyToLaunch(modsWithIds, dayZExecutablePath, verification?.skipped);
  }

  console.log(`Launching DayZ: ${dayZExecutablePath}`);
  console.log(`Arguments: ${redactArgsForLog(args)}`);

  let dayZProcess: ChildProcess;

  if (isLinux) {
    // On Linux, use Steam to launch DayZ with Proton
    // Steam handles the Wine/Proton environment setup
    const dayzAppId = edition.appId;
    
    console.log(`🐧 Linux detected - launching via Steam with Proton`);
    
    // Detect Steam installation (native or Flatpak)
    const { detectSteamInstallation } = await import('./platform-utils');
    const steamInstall = await detectSteamInstallation();
    
    if (!steamInstall) {
      throw new Error('Steam not found. Please install Steam to play DayZ on Linux.');
    }
    
    console.log(`Steam type: ${steamInstall.type}`);
    console.log(`Steam command: ${steamInstall.command}`);

    // dztui-style launch:
    // - Native Steam: steam -applaunch 221100 <args>
    // - Flatpak Steam: flatpak run com.valvesoftware.Steam -applaunch 221100 <args>
    // When running inside Flatpak Steam, we must use flatpak-spawn --host because
    // there is no host `steam` binary (Flatpak-only install).
    // -nolauncher bypasses the DayZ Launcher and launches the game directly 
    const steamArgs = ['-applaunch', dayzAppId, '-nolauncher', ...args];
    console.log(`Steam args: ${redactArgsForLog(steamArgs)}`);

    if (steamInstall.type === 'flatpak') {
      // For Flatpak Steam: Use flatpak-spawn to launch via host
      console.log('🔧 Launching DayZ via Flatpak Steam (flatpak-spawn)...');
      
      const forwardedEnv: string[] = [];
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (typeof uid === 'number') {
        forwardedEnv.push(`--env=XDG_RUNTIME_DIR=/run/user/${uid}`);
        forwardedEnv.push(`--env=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`);
      }
      
      const envKeys = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY'] as const;
      for (const k of envKeys) {
        const v = process.env[k];
        if (v && typeof v === 'string' && v.trim()) {
          forwardedEnv.push(`--env=${k}=${v}`);
        }
      }
      
      const flatpakArgs = ['flatpak', 'run', 'com.valvesoftware.Steam', ...steamArgs];
      console.log('DEBUG: Full command:', 'flatpak-spawn', redactArgsForLog(['--host', ...forwardedEnv, ...flatpakArgs]));
      
      dayZProcess = spawnGame(
        'flatpak-spawn',
        ['--host', ...forwardedEnv, ...flatpakArgs],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true
        }
      );
    } else {
      console.log('🔧 Launching DayZ via native Steam (steam -applaunch ...)');
      dayZProcess = spawnGame('steam', steamArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });
    }

    // Log any errors 
    dayZProcess.stderr?.on('data', (data) => {
      console.error(`[DayZ Launch Error] ${data.toString()}`);
    });

    dayZProcess.on('error', (error) => {
      console.error(`[DayZ Launch Failed]`, error);
    });

    dayZProcess.on('exit', (code, signal) => {
      console.log(`[DayZ Process Exit] Code: ${code}, Signal: ${signal}`);
    });

    // On Linux, quit the launcher after a short delay to release the steamworks.js app ID lock
    // This is required for BOTH Flatpak and native Steam because steamworks.js locks the app ID
    console.log('🐧 Quitting launcher in 2 seconds to release app ID lock...');
    // Not under e2e: the suite asserts on the launcher after the launch
    if (!e2eHooks) setTimeout(() => {
      console.log('👋 Goodbye! DayZ should be launching now.');
      const { app } = require('electron');
      app.quit();
    }, 2000);

  } else {
    // Windows - direct execution
    dayZProcess = spawnGame(dayZExecutablePath, args, {
      cwd: dayzRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
  }
  
  dayZProcess.unref();

  console.log(`✅ Day(Z) Beans Launchered successfully, PID: ${dayZProcess.pid}`);

  return dayZProcess;
}

/**
 * Validates and auto-fixes the DayZ path setting
 * Returns the corrected path if fixable, null if unfixable
 */
export async function validateAndFixDayZPath(
  customPath: string,
  edition: GameEdition = GAME_EDITIONS.stable
): Promise<{ valid: boolean; correctedPath?: string; error?: string }> {
  if (!customPath || typeof customPath !== 'string') {
    return { valid: false, error: 'No path provided' };
  }

  // Case 1: User pointed to an executable file
  if (customPath.toLowerCase().endsWith('.exe')) {
    const exeName = path.basename(customPath);
    const dirPath = path.dirname(customPath);
    
    if (exeName.toLowerCase() === 'dayz_be.exe') {
      // Correct executable specified
      if (await pathExists(customPath)) {
        return { valid: true, correctedPath: dirPath };
      }
      return { valid: false, error: `DayZ_BE.exe not found at: ${customPath}` };
    }
    
    // Wrong executable specified - try to auto-fix by using the directory
    console.log(`⚠️ Wrong executable specified: ${exeName}. Attempting auto-fix...`);
    
    // Check if DayZ_BE.exe exists in the same directory
    const correctExePath = path.join(dirPath, 'DayZ_BE.exe');
    if (await pathExists(correctExePath)) {
      console.log(`✅ Auto-fix successful: Found DayZ_BE.exe in ${dirPath}`);
      return { valid: true, correctedPath: dirPath };
    }
    
    // Check if this looks like a Steam path and try to find DayZ folder
    if (dirPath.toLowerCase().includes('steamapps') && dirPath.toLowerCase().includes('common')) {
      // User might have pointed to wrong game, try to find DayZ in common folder
      const commonPath = dirPath.substring(0, dirPath.toLowerCase().indexOf('common') + 6);
      const dayzPath = path.join(commonPath, 'DayZ', 'DayZ_BE.exe');
      if (await pathExists(dayzPath)) {
        console.log(`✅ Auto-fix successful: Found DayZ at ${path.dirname(dayzPath)}`);
        return { valid: true, correctedPath: path.dirname(dayzPath) };
      }
    }
    
    return { 
      valid: false, 
      error: `Wrong executable: ${exeName}. Expected DayZ_BE.exe. DayZ not found in ${dirPath}` 
    };
  }
  
  // Case 2: User pointed to a directory: the DayZ folder itself, or a library root /
  // steamapps / common folder above it (see dayZFoldersUnder).
  const installDir = await readInstallDirFromManifest(customPath, edition);
  for (const dir of dayZFoldersUnder(customPath, path.sep as PathSeparator, installDir ?? edition.defaultInstallDir)) {
    if (await pathExists(path.join(dir, 'DayZ_BE.exe'))) {
      return { valid: true, correctedPath: dir };
    }
  }
  
  return { valid: false, error: `DayZ_BE.exe not found in: ${customPath}` };
}

/** The DayZ folder name from the app manifest, when `dir` is a library root, its steamapps or steamapps/common. */
async function readInstallDirFromManifest(dir: string, edition: GameEdition): Promise<string | null> {
  for (const library of [dir, path.join(dir, '..'), path.join(dir, '..', '..')]) {
    const installDir = readDayZInstallDirName(library, edition);
    if (installDir) return installDir;
  }
  return null;
}

/**
 * Finds the DayZ executable path
 * Uses platform-specific paths for Windows and Linux
 * Auto-fixes invalid paths when possible
 */
export async function findDayZExecutable(edition: GameEdition = GAME_EDITIONS.stable): Promise<string | null> {
  // 1. Check settings first
  const customPath = store.get(edition.settingsKey);
  const hasUserPath = !!(customPath && typeof customPath === 'string' && customPath.trim());
  if (customPath && typeof customPath === 'string') {
    const validation = await validateAndFixDayZPath(customPath, edition);
    
    if (validation.valid && validation.correctedPath) {
      // If the path was corrected (e.g., wrong exe → directory), save the fix
      if (validation.correctedPath !== customPath) {
        console.log(`🔧 Auto-correcting DayZ path from "${customPath}" to "${validation.correctedPath}"`);
        store.set(edition.settingsKey, validation.correctedPath);
      }
      
      const executablePath = path.join(validation.correctedPath, 'DayZ_BE.exe');
      logToFile(`[DayZ detection${edition.id === 'experimental' ? ' (Experimental)' : ''}] Using saved path: ${executablePath}`);
      return executablePath;
    } else {
      // Do NOT delete the saved path here: validation can fail transiently (drive not
      // mounted yet, path temporarily unreachable), and wiping it would force the user
      // to reconfigure. Keep it and fall through to default-location detection; the user
      // can correct it explicitly in settings if it is genuinely wrong.
      logToFile(`[DayZ detection${edition.id === 'experimental' ? ' (Experimental)' : ''}] Saved path failed validation (keeping it): ${validation.error}`);
    }
  }

  // 2. Ask Steam: every library it knows about, then the usual folders
  const candidateDirs = await getDayZInstallDirCandidates(edition);

  for (const detectedDir of candidateDirs) {
    const execPath = path.join(detectedDir, 'DayZ_BE.exe');
    if (await pathExists(execPath)) {
      logToFile(`[DayZ detection${edition.id === 'experimental' ? ' (Experimental)' : ''}] Found at: ${execPath}`);
      // Only persist an auto-detected path when the user never set one. Overwriting an
      // explicit setting turned a transient validation failure (unmounted drive, slow
      // network share) into a permanent silent change of the user's configured install.
      if (!hasUserPath) {
        store.set(edition.settingsKey, detectedDir);
      } else {
        logToFile(`[DayZ detection${edition.id === 'experimental' ? ' (Experimental)' : ''}] Using detected path for this launch only; keeping user setting: ${customPath}`);
      }
      return execPath;
    }
  }
  
  // Listed so a support thread shows where we looked; on a packaged Windows build only
  // app-debug.log survives, console output goes nowhere.
  logToFile(`[DayZ detection${edition.id === 'experimental' ? ' (Experimental)' : ''}] Not found. Looked in:\n  ${candidateDirs.join('\n  ')}`);
  return null;
}
