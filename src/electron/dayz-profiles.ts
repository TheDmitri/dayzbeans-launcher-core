import { app } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';

const store = new Store();

export interface DayZProfile {
  /** Profile name as DayZ knows it: the per-profile filename without its suffix. */
  name: string;
  /** Directory the profile files live in — the value for `-profiles=`. */
  directory: string;
  /** mtime in ms, used to surface the most recently played profile first. */
  modifiedAt: number;
  /** True when `directory` is the resolved default Documents\DayZ folder. */
  isDefaultDirectory: boolean;
}

/**
 * A player profile called "Bob" is stored as Bob_settings.DayZProfile plus
 * Bob.core.xml / Bob.dayz_preset_User.xml. The directory also holds engine-owned files with
 * the same extension (chars.DayZProfile, news.DayZProfile, profile.vars.DayZProfile) —
 * matching every *.DayZProfile would offer those as selectable profile names, so key off the
 * per-profile suffixes only.
 */
const PROFILE_SUFFIXES = ['_settings.dayzprofile', '.core.xml', '.dayz_preset_user.xml'];

/** Returns the profile name a directory entry belongs to, or null when it is not a profile file. */
function profileNameFromEntry(entry: string): string | null {
  const lower = entry.toLowerCase();
  for (const suffix of PROFILE_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      const name = entry.slice(0, entry.length - suffix.length);
      return name.length > 0 ? name : null;
    }
  }
  return null;
}

/**
 * Resolves Documents\DayZ. Documents may be redirected (OneDrive backup, moved to another
 * drive), so ask Electron for the real known folder before falling back to the home directory.
 */
export function getDefaultProfilesPath(): string {
  let documentsDir = '';
  try {
    documentsDir = app.getPath('documents');
  } catch {
    documentsDir = path.join(os.homedir(), 'Documents');
  }
  return path.join(documentsDir, 'DayZ');
}

/** Every directory that may hold DayZ profiles, most authoritative first. */
function getProfileDirectoryCandidates(): string[] {
  const home = os.homedir();
  const configuredPath = store.get('settings.profilesPath', '') as string;

  return [
    configuredPath && typeof configuredPath === 'string' ? configuredPath.trim() : '',
    getDefaultProfilesPath(),
    path.join(home, 'Documents', 'DayZ'),
    path.join(home, 'OneDrive', 'Documents', 'DayZ'),
    // Linux/Proton: the game writes inside its Wine prefix. We never pass -profiles there,
    // but -name still selects the profile, so these must be offered too.
    path.join(home, '.steam', 'steam', 'steamapps', 'compatdata', '221100', 'pfx',
      'drive_c', 'users', 'steamuser', 'Documents', 'DayZ'),
    path.join(home, '.local', 'share', 'Steam', 'steamapps', 'compatdata', '221100', 'pfx',
      'drive_c', 'users', 'steamuser', 'Documents', 'DayZ'),
  ].filter(p => !!p);
}

/**
 * Lists the DayZ profiles that already exist on disk, so the user can pick the profile the
 * game was already using instead of us inventing a new one. Launching with a -name the game
 * has never seen makes DayZ create a fresh profile: keybinds, gameplay and video settings all
 * look "reset". Same for a -profiles directory the game does not use.
 */
export async function scanDayZProfiles(): Promise<{ defaultProfilesPath: string; profiles: DayZProfile[] }> {
  const defaultProfilesPath = getDefaultProfilesPath();
  const seenDirs = new Set<string>();
  const profiles: DayZProfile[] = [];

  for (const dir of getProfileDirectoryCandidates()) {
    const resolved = path.resolve(dir);
    if (seenDirs.has(resolved.toLowerCase())) continue;
    seenDirs.add(resolved.toLowerCase());

    let entries: string[];
    try {
      entries = await fs.promises.readdir(resolved);
    } catch {
      continue; // directory does not exist / not readable
    }

    const namesInDir = new Map<string, number>();

    for (const entry of entries) {
      const name = profileNameFromEntry(entry);
      if (!name) continue;

      let modifiedAt = 0;
      try {
        modifiedAt = (await fs.promises.stat(path.join(resolved, entry))).mtimeMs;
      } catch {
        // keep 0 — ordering only
      }
      namesInDir.set(name, Math.max(namesInDir.get(name) ?? 0, modifiedAt));
    }

    for (const [name, modifiedAt] of namesInDir) {
      profiles.push({
        name,
        directory: resolved,
        modifiedAt,
        // On Linux we never pass -profiles (Proton resolves its own prefix path), so every
        // directory counts as "default" and the picker leaves -profiles alone.
        isDefaultDirectory: process.platform !== 'win32'
          || resolved.toLowerCase() === path.resolve(defaultProfilesPath).toLowerCase(),
      });
    }
  }

  // Most recently used first — that is almost always the profile the user plays on.
  profiles.sort((a, b) => b.modifiedAt - a.modifiedAt);

  return { defaultProfilesPath, profiles };
}

/**
 * The folder the launcher considers "the" profiles folder, so it can be opened in the file
 * manager: where the selected profile lives, else where the most recently played one lives,
 * else the configured or default path. On Linux/Proton the real folder sits inside the Wine
 * prefix, which is why this follows the profiles found on disk instead of assuming Documents.
 */
export async function resolveProfilesFolder(): Promise<{ path: string; exists: boolean }> {
  const { profiles } = await scanDayZProfiles();
  const selected = ((store.get('settings.profileName', '') as string) || '').trim().toLowerCase();

  const match = selected ? profiles.find(p => p.name.toLowerCase() === selected) : undefined;
  const configured = (store.get('settings.profilesPath', '') as string) || '';
  const folder = match?.directory
    ?? profiles[0]?.directory
    ?? (typeof configured === 'string' && configured.trim() ? path.resolve(configured.trim()) : getDefaultProfilesPath());

  return { path: folder, exists: fs.existsSync(folder) };
}

/** Characters Windows forbids in filenames; a profile name becomes part of a filename. */
const INVALID_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const MAX_PROFILE_NAME_LENGTH = 32;

export function validateProfileName(name: string): { valid: boolean; error?: string } {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Enter a name for the new profile.' };
  }
  if (trimmed.length > MAX_PROFILE_NAME_LENGTH) {
    return { valid: false, error: `Profile names are limited to ${MAX_PROFILE_NAME_LENGTH} characters.` };
  }
  if (INVALID_NAME_CHARS.test(trimmed) || trimmed === '.' || trimmed === '..') {
    return { valid: false, error: 'A profile name cannot contain < > : " / \\ | ? *' };
  }
  // Trailing dots and spaces are silently stripped by Windows, so the file the game looks for
  // would not match the name we pass through -name.
  if (/[. ]$/.test(trimmed)) {
    return { valid: false, error: 'A profile name cannot end with a dot or a space.' };
  }
  return { valid: true };
}

/**
 * Copies an existing profile's files under a new name, which is the only way to change the
 * in-game name without losing settings: in DayZ the in-game name *is* the profile name, and
 * `-name=` pins it, so a rename in the main menu does not survive the next launch. Cloning
 * reproduces what players otherwise do by hand — duplicate the profile files in
 * Documents\DayZ and rename them — so keybinds, control presets, video and gameplay settings
 * carry over to the new name.
 */
export async function cloneDayZProfile(
  sourceName: string,
  sourceDirectory: string,
  newName: string
): Promise<{ success: boolean; profile?: DayZProfile; copiedFiles?: string[]; error?: string }> {
  const source = (sourceName || '').trim();
  const target = (newName || '').trim();

  if (!source) {
    return { success: false, error: 'No source profile to copy from.' };
  }

  const validation = validateProfileName(target);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  if (source.toLowerCase() === target.toLowerCase()) {
    return { success: false, error: 'The new name is the same as the profile it copies.' };
  }

  const directory = path.resolve((sourceDirectory || '').trim() || getDefaultProfilesPath());

  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch (error) {
    return { success: false, error: `Cannot read ${directory}: ${(error as Error).message}` };
  }

  const lowerSource = source.toLowerCase();
  const lowerTarget = target.toLowerCase();

  // Every per-profile file of the source, keeping the on-disk suffix casing. Control presets
  // may exist under names other than the default `User` one, so match the whole family.
  const toCopy = entries.filter(entry => {
    const lower = entry.toLowerCase();
    if (!lower.startsWith(lowerSource)) return false;
    const suffix = lower.slice(lowerSource.length);
    return PROFILE_SUFFIXES.includes(suffix)
      || (suffix.startsWith('.dayz_preset_') && suffix.endsWith('.xml'));
  });

  if (toCopy.length === 0) {
    return { success: false, error: `No profile files found for "${source}" in ${directory}.` };
  }

  const conflicts = entries.filter(entry => {
    const name = profileNameFromEntry(entry);
    return name !== null && name.toLowerCase() === lowerTarget;
  });
  if (conflicts.length > 0) {
    return { success: false, error: `A profile named "${target}" already exists. Pick it in the list instead.` };
  }

  const copiedFiles: string[] = [];
  try {
    for (const entry of toCopy) {
      const destination = target + entry.slice(source.length);
      await fs.promises.copyFile(
        path.join(directory, entry),
        path.join(directory, destination),
        fs.constants.COPYFILE_EXCL
      );
      copiedFiles.push(destination);
    }
  } catch (error) {
    // Leave no half-cloned profile behind: the game would load it with partial settings.
    for (const copied of copiedFiles) {
      try {
        await fs.promises.unlink(path.join(directory, copied));
      } catch {
        // best effort
      }
    }
    return { success: false, error: `Could not copy profile files: ${(error as Error).message}` };
  }

  const defaultProfilesPath = getDefaultProfilesPath();
  return {
    success: true,
    copiedFiles,
    profile: {
      name: target,
      directory,
      modifiedAt: Date.now(),
      isDefaultDirectory: process.platform !== 'win32'
        || directory.toLowerCase() === path.resolve(defaultProfilesPath).toLowerCase(),
    },
  };
}

interface ProfileSnapshot {
  /** Lowercased names of every profile that existed when the game was launched. */
  knownNames: string[];
  /** The profile the launcher pinned through -name, empty when it passed none. */
  selectedName: string;
  /** Launch time in ms, so a profile created before the session is not reported as new. */
  at: number;
}

/**
 * Remembers which profiles exist at launch time. A player who renames themselves in the DayZ
 * main menu ends up with a new profile on disk, and the launcher would keep forcing the old
 * -name on the next launch — so we compare against this snapshot afterwards.
 */
export async function recordProfileSnapshot(): Promise<void> {
  try {
    const { profiles } = await scanDayZProfiles();
    const selectedName = (store.get('settings.profileName', '') as string) || '';
    const snapshot: ProfileSnapshot = {
      knownNames: profiles.map(p => p.name.toLowerCase()),
      selectedName: typeof selectedName === 'string' ? selectedName.trim() : '',
      at: Date.now(),
    };
    store.set('profileSnapshot', snapshot);
  } catch (error) {
    console.error('⚠️ Could not record DayZ profile snapshot:', error);
  }
}

/**
 * Reports a profile DayZ created since the last launch, which is what an in-game rename looks
 * like on disk. One-shot: the snapshot is cleared once a result is returned, so the prompt
 * does not come back for a profile the user already answered about.
 */
export async function detectProfileDrift(): Promise<DayZProfile | null> {
  const snapshot = store.get('profileSnapshot') as ProfileSnapshot | undefined;
  if (!snapshot || !Array.isArray(snapshot.knownNames)) {
    return null;
  }

  const { profiles } = await scanDayZProfiles();
  const known = new Set(snapshot.knownNames);
  const selected = (snapshot.selectedName || '').toLowerCase();

  // A minute of slack: the profile files are written while the game starts, and clocks and
  // filesystem timestamp granularity do not have to agree with ours.
  const createdSinceLaunch = profiles.filter(p =>
    !known.has(p.name.toLowerCase())
    && p.name.toLowerCase() !== selected
    && p.modifiedAt >= snapshot.at - 60_000
  );

  if (createdSinceLaunch.length === 0) {
    return null;
  }

  store.delete('profileSnapshot');
  // scanDayZProfiles() already sorts newest first.
  return createdSinceLaunch[0];
}
