import {
  DEFAULT_GAME_PORT,
  MAX_ADDRESS_QUERY_PORTS,
  broadcastAddress,
  candidateQueryPorts,
  inSubnet,
  isExperimentalServerPath,
  isPrivateIPv4,
  isQueryableIPv4,
  localModLinkName,
  parseModDisplayName,
  parsePublishedId,
  parseServerConfig,
  parseTasklistPids,
  pidKeyOf,
  readServerArgs,
  tokenizeCommandLine,
  workshopIdFromFolderName,
} from './server-process-parse';

describe('server-process-parse', () => {
  describe('process list', () => {
    it('reads PIDs from tasklist CSV output', () => {
      const out = '"DayZServer_x64.exe","4120","Console","1","1,204,332 K"\r\n"DayZServer_x64.exe","88","Console","1","900 K"\r\n';
      expect(parseTasklistPids(out)).toEqual([4120, 88]);
    });

    it('treats the localized "no tasks" notice as no PIDs', () => {
      expect(parseTasklistPids('INFORMATION : aucune tâche en service ne correspond aux critères spécifiés.\r\n')).toEqual([]);
    });

    it('keys a PID set independently of order and repeats', () => {
      expect(pidKeyOf([88, 4120, 88])).toBe(pidKeyOf([4120, 88]));
      expect(pidKeyOf([])).toBe('');
    });
  });

  describe('command line', () => {
    it('splits a Windows command line with quoted paths and a quoted -mod list', () => {
      const argv = tokenizeCommandLine(
        '"C:\\Program Files (x86)\\Steam\\steamapps\\common\\DayZServer\\DayZServer_x64.exe" -config=serverDZ.cfg ' +
        '-port=2402 "-profiles=C:\\DayZ Profiles" -mod="@CF;@VPPAdminTools;@jp_client" -serverMod=@ServerOnly -dologs');

      expect(argv[0]).toBe('C:\\Program Files (x86)\\Steam\\steamapps\\common\\DayZServer\\DayZServer_x64.exe');
      expect(argv).toContain('-profiles=C:\\DayZ Profiles');
      expect(readServerArgs(argv)).toEqual({
        gamePort: 2402,
        configPath: 'serverDZ.cfg',
        modEntries: ['@CF', '@VPPAdminTools', '@jp_client'],
      });
    });

    it('reads a Linux argv, keys in any case, and defaults the port', () => {
      expect(readServerArgs(['./DayZServer', '-Config=cfg/serverDZ.cfg', '-MOD=@1559212036;@1564026768;', '-freezecheck'])).toEqual({
        gamePort: DEFAULT_GAME_PORT,
        configPath: 'cfg/serverDZ.cfg',
        modEntries: ['@1559212036', '@1564026768'],
      });
    });

    it('ignores an out-of-range port', () => {
      expect(readServerArgs(['-port=70000']).gamePort).toBe(DEFAULT_GAME_PORT);
      expect(readServerArgs(['-port=abc']).gamePort).toBe(DEFAULT_GAME_PORT);
    });
  });

  describe('serverDZ.cfg', () => {
    const CFG = [
      'hostname = "My Test Server | Chernarus [3PP]";   // Server name',
      'password = "hunter22";            // Password to connect',
      'passwordAdmin = "changeme-admin";',
      'maxPlayers = 50;',
      '/* steamQueryPort = 9999; */',
      'steamQueryPort = 2305; // Steam query port',
    ].join('\r\n');

    it('reads the query port, name and player limit, ignoring comments', () => {
      const summary = parseServerConfig(CFG);

      expect(summary.steamQueryPort).toBe(2305);
      expect(summary.hostname).toBe('My Test Server | Chernarus [3PP]');
      expect(summary.maxPlayers).toBe(50);
    });

    it('says whether a password is set without ever returning it', () => {
      const summary = parseServerConfig(CFG);

      expect(summary.hasPassword).toBeTrue();
      expect(JSON.stringify(summary)).not.toContain('hunter22');
      expect(parseServerConfig('password = "";').hasPassword).toBeFalse();
    });

    it('leaves the query port unset when the config has none', () => {
      expect(parseServerConfig('hostname = "x";').steamQueryPort).toBeNull();
    });
  });

  describe('mod folders', () => {
    it('reads a Workshop id from meta.cpp or from an @id folder name', () => {
      expect(parsePublishedId('protocol = 1;\npublishedid = 1559212036;\nname = "CF";')).toBe(1559212036);
      expect(parsePublishedId('publishedid = 0;')).toBeNull();
      expect(parsePublishedId('name = "local";')).toBeNull();
      expect(workshopIdFromFolderName('@1559212036')).toBe(1559212036);
      expect(workshopIdFromFolderName('@jp_client')).toBeNull();
    });

    it('reads a display name from mod.cpp', () => {
      expect(parseModDisplayName('name = "JP Client";\npicture = "x";')).toBe('JP Client');
      expect(parseModDisplayName('picture = "x";')).toBeNull();
    });

    it('builds link names that cannot escape the folder they are created in', () => {
      expect(localModLinkName('@jp_client')).toBe('@dzbl_local_jp_client');
      expect(localModLinkName('@../../etc')).toBe('@dzbl_local_______etc');
      expect(localModLinkName('@My Mod (v2)')).toBe('@dzbl_local_My_Mod__v2_');
    });

    it('recognises the Experimental server install folder', () => {
      expect(isExperimentalServerPath('/home/me/.steam/steam/steamapps/common/DayZ Server Exp/DayZServer')).toBeTrue();
      expect(isExperimentalServerPath('C:\\Steam\\steamapps\\common\\DayZServer\\DayZServer_x64.exe')).toBeFalse();
    });
  });

  describe('query ports', () => {
    it('tries the backend hint first, then the conventions, at most six, never the game port', () => {
      expect(candidateQueryPorts(2302, 2310)).toEqual([2310, 2303, 2305, 27016, 2304]);
      expect(candidateQueryPorts(2302)).toEqual([2303, 2305, 27016, 2304]);
      expect(candidateQueryPorts(2402, 2402)).toEqual([2403, 2405, 27116, 2404, 27016]);
      expect(candidateQueryPorts(65535).every(port => port <= 65535)).toBeTrue();
      expect(candidateQueryPorts(2302, 9999).length).toBeLessThanOrEqual(MAX_ADDRESS_QUERY_PORTS);
    });
  });

  describe('addresses', () => {
    it('computes directed broadcast addresses and subnet membership', () => {
      expect(broadcastAddress('192.168.1.42', '255.255.255.0')).toBe('192.168.1.255');
      expect(broadcastAddress('10.1.2.3', '255.255.0.0')).toBe('10.1.255.255');
      expect(broadcastAddress('10.0.0.1', '255.255.255.255')).toBeNull();
      expect(inSubnet('192.168.1.7', '192.168.1.42', '255.255.255.0')).toBeTrue();
      expect(inSubnet('192.168.2.7', '192.168.1.42', '255.255.255.0')).toBeFalse();
    });

    it('accepts only private ranges for the LAN scan', () => {
      expect(['10.0.0.5', '172.16.4.1', '172.31.0.1', '192.168.1.42', '169.254.3.3'].every(isPrivateIPv4)).toBeTrue();
      expect(['8.8.8.8', '172.32.0.1', '203.0.113.50', 'nope'].some(isPrivateIPv4)).toBeFalse();
    });

    it('refuses addresses a lookup must never send to', () => {
      expect(isQueryableIPv4('203.0.113.50')).toBeTrue();
      expect(isQueryableIPv4('127.0.0.1')).toBeTrue();
      for (const ip of ['0.0.0.0', '255.255.255.255', '224.0.0.1', '239.255.255.250', '192.168.1.255', '1.2.3']) {
        expect(isQueryableIPv4(ip)).withContext(ip).toBeFalse();
      }
    });
  });
});
