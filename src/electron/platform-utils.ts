/**
 * Platform Utilities
 * 
 * Centralizes all OS-specific logic for cross-platform compatibility.
 * Supports Windows, Linux, and macOS.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logToFile } from './logger';

const execAsync = promisify(exec);

// =============================================================================
// Platform Detection
// =============================================================================

export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';
export const isMac = process.platform === 'darwin';

export type Platform = 'windows' | 'linux' | 'mac';

export function getPlatform(): Platform {
  if (isWindows) return 'windows';
  if (isLinux) return 'linux';
  return 'mac';
}

// =============================================================================
// Path Utilities
// =============================================================================

/**
 * Get the user's home directory
 */
export function getHomeDir(): string {
  return os.homedir();
}

/**
 * Get the default Steam installation directory
 */
export function getDefaultSteamPath(): string {
  if (isWindows) {
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const programW6432 = process.env['ProgramW6432'] || programFiles;
    const systemDrive = process.env['SystemDrive'] || 'C:';

    const paths = [
      path.join(programFilesX86, 'Steam'),
      path.join(programFiles, 'Steam'),
      path.join(programW6432, 'Steam'),
      // Plenty of players install Steam at a drive root to keep it off the system
      // partition. Probing the obvious ones is cheap and catches the common case
      // where the registry is stale after a move.
      path.join(systemDrive, '\\Steam'),
      ...['D:', 'E:', 'F:', 'G:'].flatMap(drive => [
        path.join(drive, '\\Steam'),
        path.join(drive, '\\Games', 'Steam'),
        path.join(drive, '\\Program Files (x86)', 'Steam'),
      ]),
    ];

    for (const p of paths) {
      // Require steam.exe, not just the folder: an uninstalled Steam frequently
      // leaves an empty "Steam" directory behind that would otherwise pass.
      if (fs.existsSync(path.join(p, 'steam.exe'))) return p;
    }

    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }

    return paths[0]; // Default fallback
  }
  
  if (isLinux) {
    const home = getHomeDir();
    const paths = [
      path.join(home, '.steam', 'steam'),
      path.join(home, '.local', 'share', 'Steam'),
      path.join(home, '.steam'),
    ];
    
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    
    return paths[0];
  }
  
  // macOS
  return path.join(getHomeDir(), 'Library', 'Application Support', 'Steam');
}

/**
 * Get the Steam apps directory (where games are installed)
 */
export function getSteamAppsPath(steamPath?: string): string {
  const steam = steamPath || getDefaultSteamPath();
  
  if (isWindows) {
    return path.join(steam, 'steamapps');
  }
  
  // Linux and macOS use lowercase
  return path.join(steam, 'steamapps');
}

/**
 * Get the DayZ installation directory
 */
export function getDayZInstallPath(steamPath?: string): string {
  const steamApps = getSteamAppsPath(steamPath);
  return path.join(steamApps, 'common', 'DayZ');
}

/**
 * Get the Steam Workshop content directory for DayZ (App ID: 221100)
 */
export function getDayZWorkshopPath(steamPath?: string): string {
  const steamApps = getSteamAppsPath(steamPath);
  return path.join(steamApps, 'workshop', 'content', '221100');
}

export async function getDayZWorkshopPathForFlatpak(): Promise<string | null> {
  if (!isLinux) return null;
  
  const home = getHomeDir();
  const flatpakPath = path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam', 'steamapps', 'workshop', 'content', '221100');
  
  if (fs.existsSync(flatpakPath)) {
    return flatpakPath;
  }
  
  return null;
}

export async function getActualDayZWorkshopPath(): Promise<string> {
  const installation = await detectSteamInstallation();
  
  if (installation.type === 'flatpak') {
    const flatpakPath = await getDayZWorkshopPathForFlatpak();
    if (flatpakPath) return flatpakPath;
  }
  
  return getDayZWorkshopPath();
}

export async function isModInstalledOnDisk(workshopId: string): Promise<boolean> {
  try {
    const workshopPath = await getActualDayZWorkshopPath();
    const modPath = path.join(workshopPath, workshopId);
    return fs.existsSync(modPath);
  } catch (error) {
    console.error('Error checking mod installation:', error);
    return false;
  }
}

export async function getInstalledModsFromDisk(): Promise<string[]> {
  try {
    const workshopPath = await getActualDayZWorkshopPath();
    if (!fs.existsSync(workshopPath)) {
      return [];
    }
    
    const entries = fs.readdirSync(workshopPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (error) {
    console.error('Error reading workshop folder:', error);
    return [];
  }
}

/**
 * Get the DayZ executable name based on platform
 */
export function getDayZExecutableName(): string {
  if (isWindows) {
    return 'DayZ_BE.exe'; // BattlEye version
  }
  
  // Linux runs through Proton - the executable is still .exe but launched differently
  return 'DayZ_BE.exe';
}

/**
 * Get possible DayZ executable paths
 */
export function getPossibleDayZPaths(): string[] {
  if (isWindows) {
    return [
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\DayZ\\DayZ_BE.exe',
      'C:\\Program Files\\Steam\\steamapps\\common\\DayZ\\DayZ_BE.exe',
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Steam', 'steamapps', 'common', 'DayZ', 'DayZ_BE.exe'),
      path.join(process.env['PROGRAMFILES'] || '', 'Steam', 'steamapps', 'common', 'DayZ', 'DayZ_BE.exe'),
    ];
  }
  
  if (isLinux) {
    const home = getHomeDir();
    return [
      path.join(home, '.steam', 'steam', 'steamapps', 'common', 'DayZ', 'DayZ_BE.exe'),
      path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common', 'DayZ', 'DayZ_BE.exe'),
      // Flatpak Steam
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam', 'steamapps', 'common', 'DayZ', 'DayZ_BE.exe'),
    ];
  }
  
  // macOS (DayZ doesn't officially support Mac, but just in case)
  return [
    path.join(getHomeDir(), 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'DayZ', 'DayZ_BE.exe'),
  ];
}

// =============================================================================
// Icon Utilities
// =============================================================================

/**
 * Get the appropriate icon extension for the platform
 */
export function getIconExtension(): string {
  if (isWindows) return '.ico';
  if (isLinux) return '.png';
  return '.icns'; // macOS
}

/**
 * Get the app icon filename
 */
export function getAppIconName(): string {
  if (isWindows) return 'dayz_beans_launcher.ico';
  if (isLinux) return 'dayz_beans_launcher_256.png';
  return 'dayz_beans_launcher.icns';
}

/**
 * Get the tray icon filename (smaller for system tray)
 */
export function getTrayIconName(): string {
  if (isWindows) return 'dayz_beans_launcher.ico';
  // Linux tray icons should be smaller
  if (isLinux) return 'dayz_beans_launcher_256.png';
  return 'dayz_beans_launcher.icns';
}

// =============================================================================
// Symlink/Junction Utilities
// =============================================================================

/**
 * Create a directory symlink/junction
 * Windows uses junctions (mklink /J), Linux/Mac use symlinks
 */
export async function createDirectoryLink(targetPath: string, linkPath: string): Promise<void> {
  // Remove existing link if present
  if (fs.existsSync(linkPath)) {
    const stats = fs.lstatSync(linkPath);
    if (stats.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }
  
  if (isWindows) {
    // Windows: Use cmd mklink /J for directory junctions (no admin required)
    await execAsync(`cmd /c mklink /J "${linkPath}" "${targetPath}"`);
  } else {
    // Linux/Mac: Use native symlinks
    await fs.promises.symlink(targetPath, linkPath, 'dir');
  }
}

/**
 * Check if a path is a symlink/junction
 */
export async function isSymlink(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.lstat(filePath);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Get the target of a symlink/junction
 */
export async function getSymlinkTarget(linkPath: string): Promise<string | null> {
  try {
    return await fs.promises.readlink(linkPath);
  } catch {
    return null;
  }
}

export function getSteamProcessNames(): string[] {
  if (isWindows) {
    return ['steam.exe'];
  }

  if (isMac) {
    return ['Steam'];
  }

  return [
    'steam',
    'Steam',
    'com.valvesoftware.Steam',
  ];
}

// =============================================================================
// Windows Steam Detection
//
// Windows detection used to lean on `tasklist` + a single HKLM registry key, both
// of which fail in ordinary setups: `tasklist` can be restricted by policy and its
// "no tasks" message is localized, and a Steam installed per-user writes HKCU, not
// HKLM/WOW6432Node. The registry is locale-independent and cheap, so it is now the
// primary source and the process listing is only a fallback.
// =============================================================================

/** One `reg query` for a single value. Returns null when the key/value is absent. */
async function readRegistryValue(keyPath: string, valueName: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`reg query "${keyPath}" /v ${valueName}`, { windowsHide: true });
    // Output shape: "    <ValueName>    REG_SZ    <data>". REG_* type names are not
    // localized, so this parses identically on every Windows UI language.
    const match = stdout.match(new RegExp(`${valueName}\\s+REG_(?:SZ|EXPAND_SZ|DWORD)\\s+(.+)`, 'i'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Registry locations that hold the Steam install path, most specific first.
 * HKCU is checked before HKLM because a per-user Steam install only writes HKCU,
 * and a user who moved Steam updates HKCU while a stale HKLM entry can survive.
 */
const WINDOWS_STEAM_PATH_KEYS: Array<{ key: string; value: string }> = [
  { key: 'HKEY_CURRENT_USER\\SOFTWARE\\Valve\\Steam', value: 'SteamPath' },
  { key: 'HKEY_CURRENT_USER\\SOFTWARE\\Valve\\Steam', value: 'InstallPath' },
  { key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Valve\\Steam', value: 'InstallPath' },
  { key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Valve\\Steam', value: 'InstallPath' },
];

export interface WindowsSteamRegistryInfo {
  /** Install path as reported by the registry, normalized to backslashes. */
  installPath: string | null;
  /** Which key the path came from — recorded for support diagnostics. */
  installPathSource: string | null;
  /**
   * PID from HKCU\...\Steam\ActiveProcess. Steam writes this while the client is
   * up and zeroes it on clean exit, so it is the most reliable running-check on
   * Windows — no process enumeration, no localized output, no policy blocks.
   */
  activePid: number | null;
}

export async function readWindowsSteamRegistry(): Promise<WindowsSteamRegistryInfo> {
  if (!isWindows) return { installPath: null, installPathSource: null, activePid: null };

  let installPath: string | null = null;
  let installPathSource: string | null = null;

  for (const { key, value } of WINDOWS_STEAM_PATH_KEYS) {
    const raw = await readRegistryValue(key, value);
    if (!raw) continue;
    // HKCU\SteamPath uses forward slashes ("c:/program files (x86)/steam").
    const normalized = raw.replace(/\//g, '\\');
    if (fs.existsSync(normalized)) {
      installPath = normalized;
      installPathSource = `${key}\\${value}`;
      break;
    }
  }

  let activePid: number | null = null;
  const rawPid = await readRegistryValue('HKEY_CURRENT_USER\\SOFTWARE\\Valve\\Steam\\ActiveProcess', 'pid');
  if (rawPid) {
    // REG_DWORD data is hex ("0x1a2b").
    const parsed = rawPid.startsWith('0x') ? parseInt(rawPid, 16) : parseInt(rawPid, 10);
    if (!isNaN(parsed) && parsed > 0) activePid = parsed;
  }

  return { installPath, installPathSource, activePid };
}

/**
 * Does a PID exist? `process.kill(pid, 0)` sends no signal, it only probes.
 * EPERM means the process exists but belongs to another user/integrity level —
 * which is itself a "Steam is running" answer, so it counts as alive.
 */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function isSteamRunning(): Promise<boolean> {
  if (isWindows) {
    // 1. Registry ActiveProcess PID — authoritative, locale-proof, no shell needed
    //    beyond one `reg query`, and unaffected by tasklist policy restrictions.
    const { activePid } = await readWindowsSteamRegistry();
    if (activePid !== null && pidExists(activePid)) {
      return true;
    }
    // 2. Fall back to process enumeration. Steam can be running with a stale/zero
    //    ActiveProcess entry (e.g. after a hard kill and restart under another
    //    account), so a negative registry answer is not conclusive.
  }

  const processes = getSteamProcessNames();
  for (const processName of processes) {
    if (await isProcessRunning(processName)) {
      return true;
    }
  }
  return false;
}

export interface SteamInstallation {
  type: 'native' | 'flatpak' | 'none';
  command: string;
  supportsNativeAPI: boolean;
  isInstalled: boolean;
  isRunning: boolean;
  installPath: string | null;
}

export async function isRunningInFlatpak(): Promise<boolean> {
  if (!isLinux) return false;
  
  try {
    return fs.existsSync('/.flatpak-info');
  } catch {
    return false;
  }
}

/**
 * Check if Steam is installed on the system (Windows: registry + file check)
 */
export async function isSteamInstalled(): Promise<{ installed: boolean; path: string | null }> {
  // First try to get Steam path from registry/common locations
  const steamPath = await getSteamInstallPath();

  if (steamPath) {
    // Verify the Steam executable exists
    const steamExe = isWindows
      ? path.join(steamPath, 'steam.exe')
      : path.join(steamPath, 'steam.sh');

    if (fs.existsSync(steamExe) || fs.existsSync(steamPath)) {
      logToFile(`[isSteamInstalled] Steam found at: ${steamPath}`);
      return { installed: true, path: steamPath };
    }
  }

  // Fallback: check default paths
  const defaultPath = getDefaultSteamPath();
  if (fs.existsSync(defaultPath)) {
    logToFile(`[isSteamInstalled] Steam found at default path: ${defaultPath}`);
    return { installed: true, path: defaultPath };
  }

  // Windows: last resort, ask a running Steam where it lives. A user who moved
  // Steam to another drive and whose registry entries are stale still gets found.
  if (isWindows) {
    const fromProcess = await getWindowsSteamPathFromProcess();
    if (fromProcess) {
      logToFile(`[isSteamInstalled] Steam found via running process: ${fromProcess}`);
      return { installed: true, path: fromProcess };
    }
  }

  logToFile('[isSteamInstalled] Steam not found');
  return { installed: false, path: null };
}

/**
 * Ask Windows for the image path of the running steam.exe, then take its folder.
 * Uses CIM/WMI through PowerShell because `tasklist` cannot report a full path.
 * Only reached when every registry key and default path has already missed.
 */
async function getWindowsSteamPathFromProcess(): Promise<string | null> {
  if (!isWindows) return null;
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'steam.exe\'\\" | Select-Object -First 1).ExecutablePath"',
      { windowsHide: true, timeout: 10000 }
    );
    const exePath = stdout.trim();
    if (exePath && fs.existsSync(exePath)) {
      return path.dirname(exePath);
    }
  } catch {
    // PowerShell unavailable or blocked by execution policy — nothing more to try.
  }
  return null;
}

export async function detectSteamInstallation(): Promise<SteamInstallation> {
  if (isWindows || isMac) {
    // Check if Steam is installed first
    const { installed, path: installPath } = await isSteamInstalled();
    const running = await isSteamRunning();

    logToFile(`[detectSteamInstallation] Windows/Mac - installed: ${installed}, running: ${running}, path: ${installPath}`);

    return {
      type: running ? 'native' : (installed ? 'native' : 'none'),
      command: isWindows ? 'steam.exe' : 'steam',
      supportsNativeAPI: running,
      isInstalled: installed,
      isRunning: running,
      installPath
    };
  }

  // Check if we're running inside Flatpak Steam sandbox
  const inFlatpak = await isRunningInFlatpak();
  
  // If we're inside Flatpak, we MUST use the Flatpak command
  if (inFlatpak) {
    console.log('🐧 Running inside Flatpak Steam sandbox - using Flatpak command');
    return {
      type: 'flatpak',
      command: 'flatpak run com.valvesoftware.Steam',
      supportsNativeAPI: true,
      isInstalled: true,
      isRunning: true,
      installPath: null
    };
  }

  // Not in Flatpak - check if Flatpak Steam is installed
  try {
    const { stdout } = await execAsync('flatpak list 2>/dev/null | grep com.valvesoftware.Steam || true');
    if (stdout.trim()) {
      const running = await isSteamRunning();
      return {
        type: 'flatpak',
        command: 'flatpak run com.valvesoftware.Steam',
        supportsNativeAPI: running,
        isInstalled: true,
        isRunning: running,
        installPath: null
      };
    }
  } catch (e) {
  }

  // Check for native Steam
  const nativeSteam = await isProcessRunning('steam');
  const { installed, path: installPath } = await isSteamInstalled();
  
  if (nativeSteam) {
    return {
      type: 'native',
      command: 'steam',
      supportsNativeAPI: true,
      isInstalled: true,
      isRunning: true,
      installPath
    };
  }
  
  // Steam installed but not running
  if (installed) {
    return {
      type: 'native',
      command: 'steam',
      supportsNativeAPI: false,
      isInstalled: true,
      isRunning: false,
      installPath
    };
  }

  return { type: 'none', command: '', supportsNativeAPI: false, isInstalled: false, isRunning: false, installPath: null };
}

export async function getSteamFlatpakPID(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('pgrep -f "com.valvesoftware.Steam" | head -1');
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function relaunchInFlatpakSteam(): Promise<boolean> {
  if (!isLinux) return false;
  
  const installation = await detectSteamInstallation();
  if (installation.type !== 'flatpak') return false;
  
  const inFlatpak = await isRunningInFlatpak();
  if (inFlatpak) return false;
  
  try {
    const launcherPath = process.execPath;
    const args = process.argv.slice(1);
    
    console.log('🔄 Relaunching with Steam Flatpak environment...');
    console.log(`   Launcher: ${launcherPath}`);
    
    const { spawn } = require('child_process');
    const flatpakArgs = [
      'run',
      '--command=' + launcherPath,
      '--filesystem=host',
      '--share=network',
      '--share=ipc',
      '--socket=x11',
      '--socket=wayland',
      '--device=dri',
      'com.valvesoftware.Steam',
      ...args
    ];
    
    console.log(`   Command: flatpak ${flatpakArgs.join(' ')}`);
    
    spawn('flatpak', flatpakArgs, {
      detached: true,
      stdio: 'ignore'
    }).unref();
    
    return true;
  } catch (error) {
    console.error('Failed to relaunch in Flatpak:', error);
    return false;
  }
}

/**
 * Process names to kill when launching DayZ
 */
export function getDayZProcessNames(): string[] {
  if (isWindows) {
    return ['DayZ_BE.exe', 'DayZ_x64.exe', 'DayZ.exe'];
  }

  // Linux - processes might have different names under Wine/Proton
  return ['DayZ_BE.exe', 'DayZ_x64.exe', 'DayZ.exe', 'DayZ'];
}

/**
 * Kill a process by name
 */
export async function killProcess(processName: string): Promise<boolean> {
  try {
    if (isWindows) {
      await execAsync(`taskkill /F /IM ${processName} 2>nul`);
    } else {
      // Linux/Mac - find matching processes but be very specific
      // Use pgrep with exact process name matching when possible
      // For Wine/Proton processes, look for the actual executable
      const { stdout } = await execAsync(`pgrep -f "${processName}" 2>/dev/null || true`);
      
      if (!stdout.trim()) {
        return false;
      }
      
      // Check each PID and kill only real DayZ game processes
      const pids = stdout.trim().split('\n');
      for (const pid of pids) {
        try {
          // Get full command line to verify it's actually a DayZ game process
          const { stdout: cmdline } = await execAsync(`ps -p ${pid} -o args= 2>/dev/null || true`);
          const fullCmd = cmdline.trim().toLowerCase();
          
          // Only kill if it's actually a Wine/Proton DayZ process
          // Must contain both wine/proton AND the DayZ executable
          const isWineProcess = fullCmd.includes('wine') || fullCmd.includes('proton');
          const isDayZExe = fullCmd.includes('dayz_be.exe') || 
                            fullCmd.includes('dayz_x64.exe') || 
                            fullCmd.includes('dayz.exe');
          
          if (isWineProcess && isDayZExe) {
            console.log(`[killProcess] Killing DayZ Wine process (PID: ${pid})`);
            await execAsync(`kill -9 ${pid} 2>/dev/null || true`);
          } else {
            console.log(`[killProcess] Skipping non-DayZ process (PID: ${pid}): ${fullCmd.substring(0, 80)}...`);
          }
        } catch {
          continue;
        }
      }
    }
    return true;
  } catch {
    // Process might not be running, that's fine
    return false;
  }
}

/**
 * Kill all DayZ-related processes
 */
export async function killAllDayZProcesses(): Promise<void> {
  const processes = getDayZProcessNames();
  await Promise.all(processes.map(p => killProcess(p)));
}

/**
 * Check if any DayZ process is currently running
 * BUG-001: On Linux, only detects Wine/Proton DayZ processes to avoid
 * false positives from the launcher itself (which contains "DayZ" in its path)
 */
export async function isDayZRunning(): Promise<boolean> {
  if (isWindows) {
    const processes = getDayZProcessNames();
    for (const processName of processes) {
      if (await isProcessRunning(processName)) {
        return true;
      }
    }
    return false;
  }

  // Linux: Search for Wine/Proton DayZ processes specifically
  // pgrep -f matches the full command line, so we look for DayZ executables
  // then verify each match is actually a Wine/Proton game process
  try {
    const { stdout } = await execAsync(`pgrep -f "DayZ" 2>/dev/null || true`);
    if (!stdout.trim()) return false;

    const ownPid = process.pid;
    const pids = stdout.trim().split('\n').filter(p => p.trim());

    for (const pid of pids) {
      const pidNum = parseInt(pid.trim(), 10);
      if (isNaN(pidNum) || pidNum === ownPid) continue;

      try {
        const { stdout: args } = await execAsync(`ps -p ${pidNum} -o args= 2>/dev/null || true`);
        const fullCmd = args.trim().toLowerCase();
        if (!fullCmd) continue;

        // Must be a Wine/Proton process running a DayZ executable
        const isWineProton = fullCmd.includes('wine') || fullCmd.includes('proton');
        const isDayZExe = fullCmd.includes('dayz_be.exe') ||
                          fullCmd.includes('dayz_x64.exe') ||
                          fullCmd.includes('dayz.exe');

        if (isWineProton && isDayZExe) {
          console.log(`[isDayZRunning] Found DayZ Wine/Proton process (PID: ${pidNum})`);
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a process is running
 */
export async function isProcessRunning(processName: string): Promise<boolean> {
  try {
    if (isWindows) {
      // Parse the CSV rather than substring-matching the whole output. The old
      // check also required the absence of the literal "no tasks", which is a
      // localized string — on a non-English Windows that guard did nothing, and
      // any locale echoing the filter back would have read as a false positive.
      try {
        const { stdout } = await execAsync(
          `tasklist /FI "IMAGENAME eq ${processName}" /FO CSV /NH`,
          { windowsHide: true, timeout: 10000 }
        );
        const running = stdout
          .split('\n')
          .map(line => line.trim())
          // A data row starts with a quoted image name; the localized
          // "no tasks are running" notice never does.
          .some(line => line.toLowerCase().startsWith(`"${processName.toLowerCase()}"`));
        if (running) {
          logToFile(`[isProcessRunning] ${processName}: true (tasklist)`);
          return true;
        }
      } catch (err) {
        // tasklist can be blocked by group policy or missing from PATH. Not fatal:
        // fall through to PowerShell so a locked-down machine still gets an answer.
        logToFile(`[isProcessRunning] tasklist failed for ${processName}: ${(err as Error).message}`);
      }

      const psName = processName.replace(/\.exe$/i, '');
      try {
        const { stdout } = await execAsync(
          `powershell -NoProfile -NonInteractive -Command "@(Get-Process -Name '${psName}' -ErrorAction SilentlyContinue).Count"`,
          { windowsHide: true, timeout: 10000 }
        );
        const count = parseInt(stdout.trim(), 10);
        const running = !isNaN(count) && count > 0;
        logToFile(`[isProcessRunning] ${processName}: ${running} (powershell)`);
        return running;
      } catch (err) {
        logToFile(`[isProcessRunning] powershell failed for ${processName}: ${(err as Error).message}`);
        return false;
      }
    } else {
      // Linux/Mac - generic process check: true if any non-self process matches.
      // NOTE: This is a GENERIC helper (used for Steam etc.). It must NOT apply
      // DayZ/Wine/Proton-specific filtering — that logic lives in isDayZRunning().
      //
      // Match by EXACT process name (pgrep -x) for plain names like "steam", NOT by full
      // command line (pgrep -f). `-f` matches any process whose cmdline merely CONTAINS the
      // string — e.g. a shell running a "steam ..." command, or the launcher's own path —
      // which produced false positives that made detectSteamInstallation() report Steam as
      // running when it wasn't (so auto-start never launched it). Reverse-DNS ids (flatpak,
      // e.g. com.valvesoftware.Steam) aren't process names, so match those via cmdline.
      const isReverseDns = processName.includes('.');
      const flag = isReverseDns ? '-f' : '-x';
      const { stdout } = await execAsync(`pgrep ${flag} "${processName}" 2>/dev/null || true`);

      if (!stdout.trim()) {
        return false;
      }

      const ownPid = process.pid;
      const pids = stdout.trim().split('\n');
      for (const pid of pids) {
        const pidNum = parseInt(pid.trim(), 10);
        if (isNaN(pidNum) || pidNum === ownPid) continue;
        // A matching process other than ourselves is running.
        return true;
      }

      return false;
    }
  } catch (error) {
    console.log(`[isProcessRunning] Error checking ${processName}:`, error);
    return false;
  }
}

// =============================================================================
// Game Launch Utilities
// =============================================================================

export interface LaunchOptions {
  ip: string;
  port: number;
  password?: string;
  mods?: string; // Semicolon-separated mod list
  extraArgs?: string[];
}

/**
 * Build command line arguments for DayZ
 */
export function buildDayZArgs(options: LaunchOptions): string[] {
  const args: string[] = [
    `-connect=${options.ip}`,
    `-port=${options.port}`,
  ];
  
  if (options.password) {
    args.push(`-password=${options.password}`);
  }
  
  if (options.mods) {
    args.push(`-mod=${options.mods}`);
  }
  
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }
  
  return args;
}

/**
 * Get the command to launch DayZ
 * On Linux, this needs to go through Steam for Proton support
 */
export function getLaunchCommand(executablePath: string, args: string[]): { command: string; args: string[]; useShell: boolean } {
  if (isWindows) {
    return {
      command: executablePath,
      args,
      useShell: false,
    };
  }
  
  // Linux: Launch through Steam with Proton
  // steam://run/221100//<args>
  // Or use: steam -applaunch 221100 <args>
  const steamArgs = ['-applaunch', '221100', ...args];
  
  return {
    command: 'steam',
    args: steamArgs,
    useShell: false,
  };
}

/**
 * Alternative: Launch DayZ directly with Proton (for advanced users)
 * Requires STEAM_COMPAT_DATA_PATH and STEAM_COMPAT_CLIENT_INSTALL_PATH
 */
export function getProtonLaunchCommand(
  executablePath: string, 
  args: string[],
  protonPath: string,
  compatDataPath: string
): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: path.join(protonPath, 'proton'),
    args: ['run', executablePath, ...args],
    env: {
      STEAM_COMPAT_DATA_PATH: compatDataPath,
      STEAM_COMPAT_CLIENT_INSTALL_PATH: getDefaultSteamPath(),
    },
  };
}

// =============================================================================
// Mod Name Utilities
// =============================================================================

/**
 * Sanitizes a mod name to be safe for Windows file system paths
 * Removes or replaces invalid characters: < > : " / \ | ? *
 * 
 * IMPORTANT: This function must be used consistently everywhere mod names
 * are used for file paths (junctions) AND launch arguments.
 */
export function sanitizeModName(modName: string): string {
  return modName
    .replace(/:/g, '-')           // Replace colons with hyphens
    .replace(/[<>"/\\|?*]/g, '')  // Remove other invalid characters
    .trim();
}

// =============================================================================
// File System Utilities
// =============================================================================

/**
 * Normalize path separators for the current platform
 */
export function normalizePath(filePath: string): string {
  if (isWindows) {
    return filePath.replace(/\//g, '\\');
  }
  return filePath.replace(/\\/g, '/');
}

/**
 * Check if a path exists (async)
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a directory exists
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

// =============================================================================
// Registry/Config Utilities (Windows-specific with Linux fallbacks)
// =============================================================================

/**
 * Get Steam installation path from registry (Windows) or common locations (Linux)
 */
export async function getSteamInstallPath(): Promise<string | null> {
  if (isWindows) {
    // Checks HKCU (per-user install) before HKLM, and both the 32- and 64-bit
    // hives — the old code read only HKLM\WOW6432Node, which is absent on a
    // per-user Steam install and left those players undetected.
    const { installPath } = await readWindowsSteamRegistry();
    if (installPath) return installPath;
  }

  // Check default locations
  const defaultPath = getDefaultSteamPath();
  if (await pathExists(defaultPath)) {
    return defaultPath;
  }

  return null;
}

// =============================================================================
// Platform Info
// =============================================================================

export interface PlatformInfo {
  platform: Platform;
  arch: string;
  release: string;
  steamPath: string | null;
  dayzPath: string | null;
  workshopPath: string | null;
}

/**
 * Get comprehensive platform information
 */
export async function getPlatformInfo(): Promise<PlatformInfo> {
  const steamPath = await getSteamInstallPath();
  const dayzPath = steamPath ? getDayZInstallPath(steamPath) : null;
  const workshopPath = steamPath ? getDayZWorkshopPath(steamPath) : null;
  
  return {
    platform: getPlatform(),
    arch: os.arch(),
    release: os.release(),
    steamPath,
    dayzPath: dayzPath && await pathExists(dayzPath) ? dayzPath : null,
    workshopPath: workshopPath && await pathExists(workshopPath) ? workshopPath : null,
  };
}

/**
 * Log platform info for debugging
 */
export async function logPlatformInfo(): Promise<void> {
  const info = await getPlatformInfo();
  console.log('=== Platform Info ===');
  console.log(`Platform: ${info.platform}`);
  console.log(`Arch: ${info.arch}`);
  console.log(`OS Release: ${info.release}`);
  console.log(`Steam Path: ${info.steamPath || 'Not found'}`);
  console.log(`DayZ Path: ${info.dayzPath || 'Not found'}`);
  console.log(`Workshop Path: ${info.workshopPath || 'Not found'}`);
  console.log('=====================');
}
