import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';

import { DayZServer } from './types/models/server.model';
import {
  isWindows,
  isLinux,
  killAllDayZProcesses,
  getPossibleDayZPaths,
  getLaunchCommand,
  pathExists,
  sanitizeModName,
} from './platform-utils';
import { createWorkshopIdSymlinks } from './mod-management';
import { recordProfileSnapshot } from './dayz-profiles';

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
 * Launches DayZ client with specified server and mods
 */
export async function launchDayZ(serverData: any, _junctionDir: string): Promise<any> {
  const { ip, port, password } = serverData;
  const dayZExecutablePath = await findDayZExecutable();

  if (!dayZExecutablePath) {
    throw new Error('DayZ executable not found. Please set the path in settings.');
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

  if (serverData.mods && serverData.mods.length > 0) {
    let modList: string;
    
    if (isLinux) {
      // Linux: Use @workshopId format (symlinks created directly in DayZ folder)
      modList = serverData.mods
        .map((mod: any) => `@${mod.workshopId || mod.steamWorkshopId}`)
        .join(';');
      
      // Create @workshopid symlinks directly in DayZ folder
      const { getActualDayZWorkshopPath } = await import('./platform-utils');
      const workshopPath = await getActualDayZWorkshopPath();
      const modsWithIds = serverData.mods.map((mod: any) => ({
        workshopId: mod.workshopId || mod.steamWorkshopId,
        name: mod.name
      }));
      await createWorkshopIdSymlinks(workshopPath, modsWithIds, dayZExecutablePath);
    } else {
      // Windows: Use @SanitizedModName format (junctions in !dzbl folder)
      modList = serverData.mods
        .map((mod: any) => `!dzbl\\@${sanitizeModName(mod.name)}`)
        .join(';');
    }
    
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

  console.log(`Launching DayZ: ${dayZExecutablePath}`);
  console.log(`Arguments: ${redactArgsForLog(args)}`);

  let dayZProcess: ChildProcess;

  if (isLinux) {
    // On Linux, use Steam to launch DayZ with Proton
    // Steam handles the Wine/Proton environment setup
    const dayzAppId = '221100';
    
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
      
      dayZProcess = spawn(
        'flatpak-spawn',
        ['--host', ...forwardedEnv, ...flatpakArgs],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true
        }
      );
    } else {
      console.log('🔧 Launching DayZ via native Steam (steam -applaunch ...)');
      dayZProcess = spawn('steam', steamArgs, {
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
    setTimeout(() => {
      console.log('👋 Goodbye! DayZ should be launching now.');
      const { app } = require('electron');
      app.quit();
    }, 2000);

  } else {
    // Windows - direct execution
    dayZProcess = spawn(dayZExecutablePath, args, {
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
export async function validateAndFixDayZPath(customPath: string): Promise<{ valid: boolean; correctedPath?: string; error?: string }> {
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
  
  // Case 2: User pointed to a directory
  const executablePath = path.join(customPath, 'DayZ_BE.exe');
  if (await pathExists(executablePath)) {
    return { valid: true, correctedPath: customPath };
  }
  
  return { valid: false, error: `DayZ_BE.exe not found in: ${customPath}` };
}

/**
 * Finds the DayZ executable path
 * Uses platform-specific paths for Windows and Linux
 * Auto-fixes invalid paths when possible
 */
export async function findDayZExecutable(): Promise<string | null> {
  // 1. Check settings first
  const customPath = store.get('settings.dayzPath');
  const hasUserPath = !!(customPath && typeof customPath === 'string' && customPath.trim());
  if (customPath && typeof customPath === 'string') {
    const validation = await validateAndFixDayZPath(customPath);
    
    if (validation.valid && validation.correctedPath) {
      // If the path was corrected (e.g., wrong exe → directory), save the fix
      if (validation.correctedPath !== customPath) {
        console.log(`🔧 Auto-correcting DayZ path from "${customPath}" to "${validation.correctedPath}"`);
        store.set('settings.dayzPath', validation.correctedPath);
      }
      
      const executablePath = path.join(validation.correctedPath, 'DayZ_BE.exe');
      console.log(`✅ DayZ executable found at: ${executablePath}`);
      return executablePath;
    } else {
      // Do NOT delete the saved path here: validation can fail transiently (drive not
      // mounted yet, path temporarily unreachable), and wiping it would force the user
      // to reconfigure. Keep it and fall through to default-location detection; the user
      // can correct it explicitly in settings if it is genuinely wrong.
      console.log(`❌ Saved DayZ path failed validation (keeping it): ${validation.error}`);
    }
  }

  // 2. Fallback to platform-specific default locations
  const possiblePaths = getPossibleDayZPaths();
  console.log(`🔍 Searching for DayZ in ${possiblePaths.length} locations...`);

  for (const execPath of possiblePaths) {
    if (await pathExists(execPath)) {
      console.log(`✅ DayZ found at: ${execPath}`);
      const detectedDir = path.dirname(execPath);
      // Only persist an auto-detected path when the user never set one. Overwriting an
      // explicit setting turned a transient validation failure (unmounted drive, slow
      // network share) into a permanent silent change of the user's configured install.
      if (!hasUserPath) {
        store.set('settings.dayzPath', detectedDir);
        console.log(`💾 Saved auto-detected DayZ path: ${detectedDir}`);
      } else {
        console.log(`ℹ️ Using detected path for this launch only; keeping user setting: ${customPath}`);
      }
      return execPath;
    }
  }
  
  console.log('❌ DayZ executable not found in any default location');
  return null;
}
