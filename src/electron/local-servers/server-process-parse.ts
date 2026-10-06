/**
 * Reading a DayZ dedicated server's setup from what is visible on this PC: its command
 * line, its serverDZ.cfg and its mod folders. Also the address arithmetic the LAN scan
 * needs and the query ports Direct Connect tries.
 *
 * Pure string work only (no fs, no child_process) so it runs under the Karma spec runner.
 * local-server-discovery.ts does the reading.
 */

/** DayZ's default game port, used when a server's command line has no -port. */
export const DEFAULT_GAME_PORT = 2302;

/** Steam's default query port, used when serverDZ.cfg sets no steamQueryPort. */
export const DEFAULT_STEAM_QUERY_PORT = 27016;

/** DayZ's documented game-port -> query-port offset (2302 -> 27016). */
export const DAYZ_QUERY_PORT_OFFSET = 24714;

/**
 * Query ports asked on 127.0.0.1 and broadcast on the LAN. These are where servers
 * actually put them: game port + 1 or + 3 (the sample serverDZ.cfg uses 2305) for the
 * first three instance slots, and Steam's default range. Live servers listed on DayZ
 * Beans use 2303, 2305 and 2402 far more than the 27016 the offset predicts.
 */
export const LOCAL_QUERY_PORTS: readonly number[] = [2303, 2305, 2403, 2405, 2503, 2505, 27015, 27016, 27017, 27018, 27019, 27020];

/** Most query ports Direct Connect tries for one address. */
export const MAX_ADDRESS_QUERY_PORTS = 6;

/** Most mod folders read from one server's -mod argument. */
export const MAX_SERVER_MODS = 128;

export interface ServerLaunchArgs {
  gamePort: number;
  /** -config value as written (relative to the server's folder unless absolute). */
  configPath: string | null;
  /** -mod entries as written, in order. */
  modEntries: string[];
}

/**
 * Splits a Windows command line the way the C runtime does for the cases a server line
 * uses: spaces separate, double quotes group, a quote may open mid-argument
 * (`-mod="@CF;@VPP"`). Backslashes are literal, which is what paths need.
 */
export function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  for (const char of line.slice(0, 32_768)) {
    if (char === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
    } else if (!inQuotes && (char === ' ' || char === '\t')) {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** The arguments of a DayZServer command line Direct Connect needs. Keys are case-insensitive. */
export function readServerArgs(argv: string[]): ServerLaunchArgs {
  const result: ServerLaunchArgs = { gamePort: DEFAULT_GAME_PORT, configPath: null, modEntries: [] };
  for (const raw of argv) {
    const match = /^-([a-zA-Z]+)=(.*)$/s.exec(raw.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].replace(/^"(.*)"$/s, '$1').trim();
    if (key === 'port') {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && port <= 65535) result.gamePort = port;
    } else if (key === 'config' && value) {
      result.configPath = value;
    } else if (key === 'mod') {
      // -serverMod folders stay on the server and are never advertised to clients.
      result.modEntries = value.split(';').map(entry => entry.trim()).filter(Boolean).slice(0, MAX_SERVER_MODS);
    }
  }
  return result;
}

export interface ServerConfigSummary {
  steamQueryPort: number | null;
  hostname: string | null;
  maxPlayers: number | null;
  /**
   * Whether a join password is set. Only the fact: the password itself is never read
   * into anything that leaves this module, and Direct Connect always asks the player.
   */
  hasPassword: boolean;
}

/** The few serverDZ.cfg values Direct Connect shows. Comments are ignored. */
export function parseServerConfig(text: string): ServerConfigSummary {
  const summary: ServerConfigSummary = { steamQueryPort: null, hostname: null, maxPlayers: null, hasPassword: false };
  const withoutBlocks = text.slice(0, 256 * 1024).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const line of withoutBlocks.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|([^;/]*))/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = (match[2] ?? match[3] ?? '').trim();
    if (key === 'steamQueryPort') {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && port <= 65535) summary.steamQueryPort = port;
    } else if (key === 'hostname') {
      summary.hostname = value.slice(0, 256) || null;
    } else if (key === 'maxPlayers') {
      const max = Number(value);
      if (Number.isInteger(max) && max >= 0 && max <= 10_000) summary.maxPlayers = max;
    } else if (key === 'password') {
      summary.hasPassword = value.length > 0;
    }
  }
  return summary;
}

/** `publishedid = 1559212036;` from a Workshop mod's meta.cpp. */
export function parsePublishedId(metaCpp: string): number | null {
  const match = /^\s*publishedid\s*=\s*(\d{1,20})\s*;/m.exec(metaCpp.slice(0, 64 * 1024));
  const id = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** `name = "...";` from a mod's meta.cpp or mod.cpp, for display. */
export function parseModDisplayName(cpp: string): string | null {
  const match = /^\s*name\s*=\s*"([^"]{1,128})"/m.exec(cpp.slice(0, 64 * 1024));
  return match ? match[1].trim() || null : null;
}

/** Workshop id of a folder named after it (`@1559212036`), the layout dayz-ctl and Linux hosts use. */
export function workshopIdFromFolderName(name: string): number | null {
  const match = /^@(\d{6,20})$/.exec(name);
  const id = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Folder name without its leading @, as shown to the player. */
export function modLabelFromFolder(folderName: string): string {
  return folderName.replace(/^@/, '').slice(0, 128) || folderName;
}

/** A safe link name for a local mod folder: letters, digits, dash and underscore only. */
export function localModLinkName(folderName: string): string {
  const cleaned = modLabelFromFolder(folderName).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `@dzbl_local_${cleaned || 'mod'}`;
}

/** True for a server install the Experimental server app put there ("DayZ Server Exp"). */
export function isExperimentalServerPath(executablePath: string): boolean {
  return /dayz\s*server\s*exp/i.test(executablePath);
}

/**
 * Query ports to try for one address, most likely first, at most six: the one the
 * backend recorded, then the conventions (+1, +3, the documented +24714, +2) and Steam's
 * default. Accepting a reply still requires its own game port to match.
 */
export function candidateQueryPorts(gamePort: number, hint?: number | null): number[] {
  const ports = [hint ?? 0, gamePort + 1, gamePort + 3, gamePort + DAYZ_QUERY_PORT_OFFSET, gamePort + 2, DEFAULT_STEAM_QUERY_PORT];
  return [...new Set(ports.filter(port => Number.isInteger(port) && port > 0 && port <= 65535 && port !== gamePort))]
    .slice(0, MAX_ADDRESS_QUERY_PORTS);
}

// --------------------------------------------------------------------------------------
// IPv4 arithmetic
// --------------------------------------------------------------------------------------

export function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

export function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join('.');
}

/** RFC 1918 and link-local: the only ranges the LAN scan sends to or accepts replies from. */
export function isPrivateIPv4(ip: string): boolean {
  const value = ipv4ToNumber(ip);
  if (value === null) return false;
  const [a, b] = [Math.floor(value / 2 ** 24), Math.floor(value / 2 ** 16) % 256];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function isLoopbackIPv4(ip: string): boolean {
  return ipv4ToNumber(ip) !== null && ip.startsWith('127.');
}

/** Directed broadcast address of an interface, or null for a /31, /32 or invalid mask. */
export function broadcastAddress(address: string, netmask: string): string | null {
  const ip = ipv4ToNumber(address);
  const mask = ipv4ToNumber(netmask);
  if (ip === null || mask === null) return null;
  const host = 0xffffffff - mask;
  if (host < 3) return null;
  return numberToIpv4(ip - (ip % (host + 1)) + host);
}

export function inSubnet(candidate: string, address: string, netmask: string): boolean {
  const ip = ipv4ToNumber(candidate);
  const base = ipv4ToNumber(address);
  const mask = ipv4ToNumber(netmask);
  if (ip === null || base === null || mask === null) return false;
  const size = 0xffffffff - mask + 1;
  return Math.floor(ip / size) === Math.floor(base / size);
}

/**
 * Whether an address may be queried by Direct Connect: a unicast IPv4 address. Refuses
 * 0.0.0.0/8, multicast, reserved and the limited broadcast address, so a lookup can
 * never be turned into a broadcast or multicast send.
 */
export function isQueryableIPv4(ip: string): boolean {
  const value = ipv4ToNumber(ip);
  if (value === null) return false;
  const first = Math.floor(value / 2 ** 24);
  if (first === 0 || first >= 224) return false;
  // A /24-style broadcast address is not knowable without the netmask; .255 is refused
  // for the common case and no real server sits on it.
  return value % 256 !== 255;
}

export function pidKeyOf(pids: number[]): string {
  return [...new Set(pids)].sort((a, b) => a - b).join(',');
}

/** PIDs from `tasklist /FO CSV /NH` output; the "no tasks" notice is localized, so it is just skipped. */
export function parseTasklistPids(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^"[^"]*","(\d+)"/.exec(line.trim());
    if (match) pids.push(Number(match[1]));
  }
  return pids;
}
