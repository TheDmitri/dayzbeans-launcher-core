/**
 * Where a DayZ install can live, worked out from Steam's own files.
 *
 * Detection used to probe four hard-coded paths under `C:\Program Files...\Steam`, so
 * anyone with DayZ in a second Steam library (`D:\SteamLibrary`) or with Steam itself
 * off the system drive got "DayZ Not Found" on first launch. Steam already records
 * every library in `libraryfolders.vdf` and the game folder of each installed app in
 * `appmanifest_<appid>.acf`; reading those finds the game wherever Steam put it.
 *
 * Pure string work only (no fs, no electron) so it runs under the Karma spec runner.
 * platform-utils does the probing.
 */

export const DAYZ_APP_ID = '221100';
export const DAYZ_DEFAULT_INSTALL_DIR = 'DayZ';
export const DAYZ_EXECUTABLE = 'DayZ_BE.exe';

/**
 * DayZ Experimental is a separate Steam app with its own install folder and its own
 * servers (they register under its app id). Everything that differs between the two
 * clients lives here, so callers pick an edition instead of hard-coding 221100.
 */
export type GameEditionId = 'stable' | 'experimental';

export interface GameEdition {
  id: GameEditionId;
  appId: string;
  /** Folder under steamapps/common when the app manifest does not say otherwise. */
  defaultInstallDir: string;
  /** electron-store key of the player's own path for this edition. */
  settingsKey: string;
}

export const GAME_EDITIONS: Record<GameEditionId, GameEdition> = {
  stable: { id: 'stable', appId: DAYZ_APP_ID, defaultInstallDir: DAYZ_DEFAULT_INSTALL_DIR, settingsKey: 'settings.dayzPath' },
  experimental: { id: 'experimental', appId: '1024020', defaultInstallDir: 'DayZ Exp', settingsKey: 'settings.dayzExpPath' },
};

/** Edition of a server or request; anything but 'experimental' is stable. */
export function editionOf(id: unknown): GameEdition {
  return id === 'experimental' ? GAME_EDITIONS.experimental : GAME_EDITIONS.stable;
}

export type PathSeparator = '/' | '\\';

/**
 * Library roots listed in a `libraryfolders.vdf`, in file order.
 *
 * Both VDF shapes are handled: the current one nests a `"path"` key per entry, the old
 * one maps an index straight to the path string. The legacy pattern is only consulted
 * when no `"path"` key exists: the modern format also holds index-keyed string pairs
 * inside each library's "apps" block ("221100" "12345678"), which would otherwise inject
 * app ids and byte counts into the list. VDF escapes backslashes, hence the unescape.
 */
export function parseLibraryFoldersVdf(contents: string, sep: PathSeparator): string[] {
  const unescape = (raw: string) => raw.replace(/\\\\/g, sep);

  const pathKeys = [...contents.matchAll(/"path"\s+"([^"]+)"/g)].map(match => unescape(match[1]));
  if (pathKeys.length > 0) {
    return pathKeys;
  }

  return [...contents.matchAll(/^\s*"\d+"\s+"([^"]+)"\s*$/gm)].map(match => unescape(match[1]));
}

/**
 * The folder name under `steamapps/common` that an app manifest says the game lives in.
 * Usually "DayZ", but Steam honours whatever was there when the library was imported.
 */
export function parseAppManifestInstallDir(contents: string): string | null {
  const match = contents.match(/"installdir"\s+"([^"]+)"/i);
  const installDir = match?.[1].trim();
  return installDir ? installDir : null;
}

/**
 * Joins with the given separator without touching the head of the first part, so a
 * POSIX root ("/") or a UNC share ("\\server\share") survives.
 */
export function joinPath(sep: PathSeparator, ...parts: string[]): string {
  const [first, ...rest] = parts.filter(part => part.length > 0);
  if (first === undefined) return '';

  let result = /^[\\/]+$/.test(first) ? first : first.replace(/[\\/]+$/, '');
  for (const part of rest) {
    const trimmed = part.replace(/^[\\/]+|[\\/]+$/g, '');
    if (!trimmed) continue;
    result = /[\\/]$/.test(result) ? result + trimmed : result + sep + trimmed;
  }
  return result;
}

/**
 * Folders that may hold DayZ_BE.exe when the user browsed to `selected`, closest first.
 *
 * Players often pick the library root or `steamapps\common` instead of the DayZ folder
 * itself. Rejecting that with "DayZ_BE.exe not found" when the game is two folders down
 * reads as the launcher being broken.
 */
export function dayZFoldersUnder(selected: string, sep: PathSeparator, installDir = DAYZ_DEFAULT_INSTALL_DIR): string[] {
  return dedupePaths([
    selected,
    joinPath(sep, selected, installDir),
    joinPath(sep, selected, 'common', installDir),
    joinPath(sep, selected, 'steamapps', 'common', installDir),
  ], sep);
}

/**
 * Drops repeats while keeping the first occurrence's position. Windows paths compare
 * case-insensitively; a trailing separator never makes two paths different.
 */
export function dedupePaths(paths: string[], sep: PathSeparator): string[] {
  const seen = new Set<string>();
  return paths.filter(candidate => {
    if (!candidate) return false;
    let key = candidate.length > 1 ? candidate.replace(/[\\/]+$/, '') : candidate;
    if (sep === '\\') key = key.replace(/\//g, '\\').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
