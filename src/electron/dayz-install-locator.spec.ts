import {
  GAME_EDITIONS,
  dayZFoldersUnder,
  dedupePaths,
  editionOf,
  joinPath,
  parseAppManifestInstallDir,
  parseLibraryFoldersVdf,
} from './dayz-install-locator';

describe('dayz-install-locator', () => {
  describe('parseLibraryFoldersVdf', () => {
    it('reads every library from the current format, unescaping Windows paths', () => {
      const vdf = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"apps"
		{
			"228980"		"340306752"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
		"apps"
		{
			"221100"		"16285474398"
		}
	}
}`;
      expect(parseLibraryFoldersVdf(vdf, '\\')).toEqual([
        'C:\\Program Files (x86)\\Steam',
        'D:\\SteamLibrary',
      ]);
    });

    it('ignores the app id / size pairs of the current format', () => {
      const vdf = `"libraryfolders" { "0" { "path" "/home/p/.local/share/Steam" "apps" { "221100" "123" } } }`;
      expect(parseLibraryFoldersVdf(vdf, '/')).toEqual(['/home/p/.local/share/Steam']);
    });

    it('falls back to the legacy index-keyed format', () => {
      const vdf = `"LibraryFolders"
{
	"TimeNextStatsReport"		"1690000000"
	"ContentStatsID"		"-123"
	"1"		"E:\\\\Games\\\\SteamLibrary"
}`;
      expect(parseLibraryFoldersVdf(vdf, '\\')).toEqual(['E:\\Games\\SteamLibrary']);
    });

    it('returns nothing for an unrelated file', () => {
      expect(parseLibraryFoldersVdf('', '/')).toEqual([]);
    });
  });

  describe('parseAppManifestInstallDir', () => {
    it('reads the installdir key', () => {
      const acf = `"AppState"
{
	"appid"		"221100"
	"name"		"DayZ"
	"installdir"		"DayZ"
}`;
      expect(parseAppManifestInstallDir(acf)).toBe('DayZ');
    });

    it('keeps a non-default folder name', () => {
      expect(parseAppManifestInstallDir('"installdir"  "DayZ Copy"')).toBe('DayZ Copy');
    });

    it('returns null when the key is missing or blank', () => {
      expect(parseAppManifestInstallDir('"appid" "221100"')).toBeNull();
      expect(parseAppManifestInstallDir('"installdir" " "')).toBeNull();
    });
  });

  describe('joinPath', () => {
    it('joins Windows segments and drops stray separators', () => {
      expect(joinPath('\\', 'D:\\SteamLibrary\\', 'steamapps', 'common', 'DayZ')).toBe('D:\\SteamLibrary\\steamapps\\common\\DayZ');
      expect(joinPath('\\', 'C:\\', 'DayZ')).toBe('C:\\DayZ');
    });

    it('keeps a POSIX root and a UNC share intact', () => {
      expect(joinPath('/', '/', 'mnt', 'games')).toBe('/mnt/games');
      expect(joinPath('\\', '\\\\nas\\games', 'DayZ')).toBe('\\\\nas\\games\\DayZ');
    });
  });

  describe('dayZFoldersUnder', () => {
    it('looks below a library root the player browsed to', () => {
      expect(dayZFoldersUnder('D:\\SteamLibrary', '\\')).toEqual([
        'D:\\SteamLibrary',
        'D:\\SteamLibrary\\DayZ',
        'D:\\SteamLibrary\\common\\DayZ',
        'D:\\SteamLibrary\\steamapps\\common\\DayZ',
      ]);
    });

    it('uses the folder name from the app manifest when given one', () => {
      expect(dayZFoldersUnder('/mnt/lib/steamapps/common', '/', 'DayZ Copy')).toContain('/mnt/lib/steamapps/common/DayZ Copy');
    });
  });

  describe('dedupePaths', () => {
    it('compares Windows paths case-insensitively and ignores trailing separators', () => {
      expect(dedupePaths(['C:\\Steam', 'c:\\steam\\', 'C:/Steam', 'D:\\Steam'], '\\')).toEqual(['C:\\Steam', 'D:\\Steam']);
    });

    it('keeps POSIX paths that differ only by case', () => {
      expect(dedupePaths(['/home/p/Steam', '/home/p/steam', '/home/p/Steam/'], '/')).toEqual(['/home/p/Steam', '/home/p/steam']);
    });
  });

  describe('editions', () => {
    it('keeps stable and Experimental apart: app id, folder, settings key', () => {
      expect(GAME_EDITIONS.stable.appId).toBe('221100');
      expect(GAME_EDITIONS.experimental.appId).toBe('1024020');
      expect(GAME_EDITIONS.experimental.defaultInstallDir).toBe('DayZ Exp');
      expect(GAME_EDITIONS.stable.settingsKey).not.toBe(GAME_EDITIONS.experimental.settingsKey);
    });

    it('treats anything but "experimental" as stable', () => {
      expect(editionOf('experimental')).toBe(GAME_EDITIONS.experimental);
      expect(editionOf('stable')).toBe(GAME_EDITIONS.stable);
      expect(editionOf(undefined)).toBe(GAME_EDITIONS.stable);
      expect(editionOf('EXPERIMENTAL')).toBe(GAME_EDITIONS.stable);
    });

    it('looks for the Experimental folder below a library the player browsed to', () => {
      expect(dayZFoldersUnder('D:\\SteamLibrary', '\\', GAME_EDITIONS.experimental.defaultInstallDir))
        .toContain('D:\\SteamLibrary\\steamapps\\common\\DayZ Exp');
    });
  });
});
