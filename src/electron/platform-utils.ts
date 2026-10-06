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
import { e2eHooks } from './e2e-hooks';
import {
  GAME_EDITIONS,
  GameEdition,
  PathSeparator,
  dedupePaths,
  parseAppManifestInstallDir,
  parseLibraryFoldersVdf,
} from './dayz-install-locator';

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

/**
 * Every Steam library root Steam knows about, primary first.
 *
 * Steam records additional libraries in `steamapps/libraryfolders.vdf` (older clients:
 * `config/libraryfolders.vdf`). Without reading it we only ever looked in the default
 * install, so a player with DayZ or its workshop content on a second drive — a very
 * common Linux setup — got a workshop root that does not exist. Every mod path built
 * from it then missed, and on Linux the join path went on to delete the correct
 * symlinks that pre-warming had created from Steam's own install info.
 *
 * Both VDF shapes are handled: the current one nests a `"path"` key per entry, the old
 * one maps an index straight to the path string.
 */
export function getSteamLibraryPaths(steamPath?: string): string[] {
  const primary = steamPath || getDefaultSteamPath();
  const roots: string[] = [primary];

  const vdfCandidates = [
    path.join(primary, 'steamapps', 'libraryfolders.vdf'),
    path.join(primary, 'config', 'libraryfolders.vdf'),
  ];

  for (const vdf of vdfCandidates) {
    try {
      if (!fs.existsSync(vdf)) continue;
      // Every candidate is then probed per mod by resolveWorkshopRootForMod.
      roots.push(...parseLibraryFoldersVdf(fs.readFileSync(vdf, 'utf-8'), path.sep as PathSeparator));
    } catch (error) {
      logToFile(`[getSteamLibraryPaths] Could not read ${vdf}: ${error}`);
    }
  }

  // De-duplicate while preserving order (primary stays first), and drop anything that is
  // not an absolute path. A relative value is never a Steam library, and path.resolve
  // would silently turn it into a path under our own working directory.
  const seen = new Set<string>();
  return roots.filter(root => {
    if (!root || !path.isAbsolute(root)) return false;
    const normalized = path.resolve(root);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Every plausible DayZ workshop content directory, most likely first.
 * Includes Flatpak Steam and each library listed in libraryfolders.vdf.
 */
export async function getDayZWorkshopPathCandidates(): Promise<string[]> {
  const candidates: string[] = [];

  const installation = await detectSteamInstallation();
  if (installation.type === 'flatpak') {
    const flatpakPath = await getDayZWorkshopPathForFlatpak();
    if (flatpakPath) candidates.push(flatpakPath);
  }

  for (const library of getSteamLibraryPaths()) {
    candidates.push(getDayZWorkshopPath(library));
  }

  // Flatpak content can exist even when the running Steam reports as native
  // (dual install, or detection falling back), so always keep it as a tail candidate.
  const flatpakFallback = await getDayZWorkshopPathForFlatpak();
  if (flatpakFallback) candidates.push(flatpakFallback);

  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export async function getActualDayZWorkshopPath(): Promise<string> {
  const candidates = await getDayZWorkshopPathCandidates();

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Nothing on disk yet (fresh install, no mods subscribed). Return the primary guess
  // so callers that create directories still have somewhere sensible to write.
  return candidates[0] || getDayZWorkshopPath();
}

/**
 * The workshop root that actually holds this mod, searching every known library.
 * Returns null when no library has it. Prefer Steam's own `installInfo.folder` when
 * you have it — this is the fallback for when the Steam API is unavailable.
 */
export async function resolveWorkshopRootForMod(workshopId: string): Promise<string | null> {
  for (const candidate of await getDayZWorkshopPathCandidates()) {
    if (fs.existsSync(path.join(candidate, workshopId))) return candidate;
  }
  return null;
}

export async function isModInstalledOnDisk(workshopId: string): Promise<boolean> {
  try {
    return (await resolveWorkshopRootForMod(workshopId)) !== null;
  } catch (error) {
    console.error('Error checking mod installation:', error);
    return false;
  }
}

export async function getInstalledModsFromDisk(): Promise<string[]> {
  try {
    const found = new Set<string>();

    for (const workshopPath of await getDayZWorkshopPathCandidates()) {
      if (!fs.existsSync(workshopPath)) continue;

      const entries = fs.readdirSync(workshopPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) found.add(entry.name);
      }
    }

    return [...found];
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

/**
 * Steam install roots worth reading libraryfolders.vdf from, most authoritative first.
 * Only roots that exist are returned.
 */
async function getSteamRootCandidates(): Promise<string[]> {
  const roots: string[] = [];

  if (isWindows) {
    const { installPath } = await readWindowsSteamRegistry();
    if (installPath) roots.push(installPath);
  }

  roots.push(getDefaultSteamPath());

  if (isLinux) {
    const home = getHomeDir();
    roots.push(
      path.join(home, '.steam', 'steam'),
      path.join(home, '.local', 'share', 'Steam'),
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'steam'),
    );
  }

  return dedupePaths(roots, path.sep as PathSeparator).filter(root => fs.existsSync(root));
}

/**
 * Library folders players commonly create by hand. Covers a Steam whose registry entry
 * and libraryfolders.vdf we could not reach at all; probing a missing drive is cheap.
 */
function getConventionalWindowsLibraries(): string[] {
  if (!isWindows) return [];
  return ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'].flatMap(drive => [
    path.join(drive, '\\SteamLibrary'),
    path.join(drive, '\\Games', 'SteamLibrary'),
    path.join(drive, '\\Steam'),
    path.join(drive, '\\Games', 'Steam'),
  ]);
}

/** The edition's install folder name from `library`'s app manifest, null when Steam does not list it there. */
export function readDayZInstallDirName(library: string, edition: GameEdition): string | null {
  const manifest = path.join(library, 'steamapps', `appmanifest_${edition.appId}.acf`);
  try {
    if (!fs.existsSync(manifest)) return null;
    return parseAppManifestInstallDir(fs.readFileSync(manifest, 'utf-8'));
  } catch (error) {
    logToFile(`[DayZ detection] Could not read ${manifest}: ${error}`);
    return null;
  }
}

function dayZDirsInLibraries(libraries: string[], edition: GameEdition): string[] {
  // A library whose app manifest lists DayZ is where Steam says the game is, so those go
  // first; the conventional folder in every library follows as a fallback.
  const fromManifests = libraries.flatMap(library => {
    const installDir = readDayZInstallDirName(library, edition);
    return installDir ? [path.join(library, 'steamapps', 'common', installDir)] : [];
  });
  const conventional = libraries.map(library => path.join(library, 'steamapps', 'common', edition.defaultInstallDir));
  return [...fromManifests, ...conventional];
}

/** Every library of every Steam install we can find, deduplicated. */
async function getAllSteamLibraries(): Promise<string[]> {
  return dedupePaths(
    (await getSteamRootCandidates()).flatMap(root => getSteamLibraryPaths(root)),
    path.sep as PathSeparator,
  );
}

/**
 * The DayZ folder of a library where Steam no longer has the game installed: no app
 * manifest and no DayZ_BE.exe, yet the folder is still there. Uninstalling through Steam
 * leaves exactly this behind, because the launcher's @mod links and DayZ's own crash logs
 * are files Steam does not own. Lets the "DayZ not found" dialog say "uninstalled" and
 * offer a reinstall instead of sending the player to a path setting that cannot help.
 */
export async function findUninstalledDayZFolder(edition: GameEdition = GAME_EDITIONS.stable): Promise<string | null> {
  for (const library of await getAllSteamLibraries()) {
    const steamapps = path.join(library, 'steamapps');
    const gameDir = path.join(steamapps, 'common', edition.defaultInstallDir);
    if (fs.existsSync(gameDir)
        && !fs.existsSync(path.join(gameDir, 'DayZ_BE.exe'))
        && !fs.existsSync(path.join(steamapps, `appmanifest_${edition.appId}.acf`))) {
      return gameDir;
    }
  }
  return null;
}

/**
 * Every folder that may hold DayZ_BE.exe, most likely first: every Steam library listed
 * by every Steam install we can find (registry, default paths, Flatpak), then
 * hand-made library folders, then the historical fixed paths.
 */
export async function getDayZInstallDirCandidates(edition: GameEdition = GAME_EDITIONS.stable): Promise<string[]> {
  const sep = path.sep as PathSeparator;
  const libraries = await getAllSteamLibraries();

  let candidates = [
    ...dayZDirsInLibraries(libraries, edition),
    ...dayZDirsInLibraries(getConventionalWindowsLibraries().filter(library => fs.existsSync(library)), edition),
    // The historical fixed paths only ever pointed at the stable client
    ...(edition.id === 'stable' ? getPossibleDayZPaths().map(executable => path.dirname(executable)) : []),
  ];

  // Last resort on Windows: ask the running steam.exe where it lives. Costs a PowerShell
  // round trip, so only when nothing above holds the game, and only for stable: most
  // players have no Experimental, and probing for it would pay that cost every time.
  if (isWindows && edition.id === 'stable' && !candidates.some(dir => fs.existsSync(path.join(dir, 'DayZ_BE.exe')))) {
    const fromProcess = await getWindowsSteamPathFromProcess();
    if (fromProcess) {
      candidates = [...dayZDirsInLibraries(getSteamLibraryPaths(fromProcess), edition), ...candidates];
    }
  }

  return dedupePaths(candidates, sep);
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
  // Remove existing link if present. lstat-based, not existsSync: a symlink or junction
  // whose target is gone still occupies the name, and symlink()/mklink would fail with
  // EEXIST if we skipped the removal below.
  if (existsOrLinkSync(linkPath)) {
    const stats = fs.lstatSync(linkPath);
    if (stats.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }
  
  if (isWindows) {
    // Windows: a junction, which needs no admin rights — same as `mklink /J`, which this
    // used to shell out to. Going through cmd meant the mod name was interpreted by the
    // shell: cmd expands %VAR% pairs even inside double quotes, so a mod titled
    // "50%-50% Loot" had "%-50%" replaced with nothing and the junction was created under
    // a different name than the one passed to -mod=. The game then loaded no mod at all.
    // fs.symlink takes the path as data, so no name can be mangled or injected.
    await fs.promises.symlink(targetPath, linkPath, 'junction');
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
  if (e2eHooks?.fakes.isSteamRunning) {
    return e2eHooks.fakes.isSteamRunning();
  }
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
  if (e2eHooks?.fakes.detectSteamInstallation) {
    return (await e2eHooks.fakes.detectSteamInstallation()) as SteamInstallation;
  }
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
  if (e2eHooks?.fakes.killAllDayZProcesses) {
    return e2eHooks.fakes.killAllDayZProcesses();
  }
  const processes = getDayZProcessNames();
  await Promise.all(processes.map(p => killProcess(p)));
}

/**
 * Check if any DayZ process is currently running
 * BUG-001: On Linux, only detects Wine/Proton DayZ processes to avoid
 * false positives from the launcher itself (which contains "DayZ" in its path)
 */
export async function isDayZRunning(): Promise<boolean> {
  if (e2eHooks?.fakes.isDayZRunning) {
    return e2eHooks.fakes.isDayZRunning();
  }
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
/**
 * How much of the mod title a Windows junction name may carry.
 *
 * The full path the game opens is `<DayZ root>\!dzbl\@<name>_<id>\addons\....pbo`, and
 * Windows still enforces MAX_PATH (260) for most callers. Capping the readable part keeps
 * that bounded no matter how verbose a workshop title is.
 */
export const MAX_MOD_LINK_NAME_LENGTH = 64;

/**
 * Build the link name for a mod: readable title plus the workshop id.
 *
 * The id is not decoration — it is what makes the name unique. Naming junctions by title
 * alone collided, and the DayZ workshop is full of reuploads sharing a title: a server
 * requiring two mods both called "Trader" produced one junction, created twice, and one
 * of the two mods never loaded. The title stays in front of it so a player (or a support
 * thread) can still read the folder listing.
 */
export function buildModLinkName(modName: string, workshopId: string | number): string {
  const readable = sanitizeModName(modName || '')
    .slice(0, MAX_MOD_LINK_NAME_LENGTH)
    // Truncation can leave a trailing space or dot, both of which Windows silently strips
    // from a directory name — which would make the name on disk differ from the name we
    // pass to -mod=.
    .replace(/[.\s]+$/, '')
    .trim();

  return `@${readable || 'Mod'}_${workshopId}`;
}

/**
 * Recover the workshop id from a link name produced by buildModLinkName.
 * Returns null for a name that does not carry one (a link from the old title-only
 * scheme, or something a player put in the folder themselves).
 */
export function parseWorkshopIdFromLinkName(linkName: string): string | null {
  const match = /_(\d+)$/.exec(linkName);
  return match ? match[1] : null;
}

export function sanitizeModName(modName: string): string {
  return modName
    .replace(/:/g, '-')           // Replace colons with hyphens
    .replace(/[<>"/\\|?*]/g, '')  // Remove other invalid characters
    // DayZ separates the -mod= list with semicolons, so a semicolon inside a mod name
    // split that one entry into two names that match nothing and the mod silently failed
    // to load. Percent signs used to be eaten by cmd's variable expansion on the way to
    // mklink; that path is gone, but they stay out of link names so a name can never be
    // reinterpreted by a shell again.
    .replace(/[;%]/g, '-')
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
 * Check whether a path is occupied, INCLUDING by a dangling symlink.
 *
 * `pathExists` uses fs.access, which follows the link — a symlink whose target is gone
 * reads back as "does not exist". Every caller that then tried to create the link got
 * EEXIST from the kernel and logged a warning, so a broken `@workshopId` link was never
 * repaired in-session: the mod silently failed to load for the rest of the run. lstat
 * does not follow, so this answers the question the link-creation code actually asks.
 */
export async function existsOrLink(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Synchronous counterpart to existsOrLink, for the sync link-creation path. */
export function existsOrLinkSync(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
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
