/**
 * Finds DayZ servers for Direct Connect: on this PC (always), on the local network (when
 * the player turns it on), and at one address the player typed.
 *
 * WHY THIS EXISTS
 * ===============
 * Direct Connect used to build a server out of the typed address alone: no name, no mod
 * list, and a query port guessed as game port + 24714, which most servers do not use.
 * Players had to know which mods a server needs and tick them by hand.
 *
 * SECURITY
 * ========
 * - The renderer never chooses what gets scanned. Discovery takes a single boolean; its
 *   targets are 127.0.0.1, the query ports of DayZServer processes on this PC, and the
 *   broadcast addresses of this machine's own private interfaces. LAN replies are
 *   accepted only from inside those subnets.
 * - A lookup takes one host and one game port. This module picks at most six query ports,
 *   refuses broadcast and multicast targets, and is rate limited.
 * - Mod folders of a server on this PC (the ones not on the Workshop) are held here and
 *   only here. The renderer gets their names and an opaque key; a join that carries the
 *   key gets the folders back from this module, re-checked on disk, and only for a join
 *   to that same server on this PC.
 * - serverDZ.cfg is read only at the path the server's own command line names, and only
 *   for its query port, name, player limit and whether a password is set. The password
 *   itself is never kept: Direct Connect always asks the player for it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dns from 'dns';
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logToFile } from '../logger';
import { queryDayZServer, broadcastInfo, DayZQueryResult } from '../a2s/a2s-client';
import { editionFromAppId } from '../a2s/dayz-a2s-codec';
import {
  DEFAULT_STEAM_QUERY_PORT,
  LOCAL_QUERY_PORTS,
  MAX_SERVER_MODS,
  ServerConfigSummary,
  broadcastAddress,
  candidateQueryPorts,
  inSubnet,
  isExperimentalServerPath,
  isLoopbackIPv4,
  isPrivateIPv4,
  isQueryableIPv4,
  ipv4ToNumber,
  localModLinkName,
  modLabelFromFolder,
  parseModDisplayName,
  parsePublishedId,
  parseServerConfig,
  readServerArgs,
  tokenizeCommandLine,
  workshopIdFromFolderName,
  parseTasklistPids,
  pidKeyOf,
} from './server-process-parse';

const execFileAsync = promisify(execFile);

export type ProbeSource = 'process' | 'loopback' | 'lan' | 'address';

export interface ProbeMod {
  workshopId: number;
  name: string;
}

/** One server as Direct Connect shows it. Mirrored by DayZServerProbeSchema in ipc-schemas.ts. */
export interface DayZServerProbe {
  ip: string;
  gamePort: number;
  queryPort: number;
  source: ProbeSource;
  /** False for a DayZServer process on this PC that does not answer queries (yet). */
  online: boolean;
  name: string;
  map: string;
  players: number;
  maxPlayers: number;
  version: string;
  appId: number | null;
  edition: 'stable' | 'experimental';
  passwordProtected: boolean;
  firstPerson: boolean;
  pingMs: number | null;
  /** Workshop mods the server needs; null when unknown (rules off, nothing on disk). */
  mods: ProbeMod[] | null;
  /** Mods that are not on the Workshop (names only). */
  unpublishedMods: Array<{ name: string }>;
  modsSource: 'rules' | 'process' | 'none';
  /** False when the server's list overflowed or could not be read at all. */
  modsComplete: boolean;
  /** Present when this module can load the unpublished mods from the server's folders. */
  localServerKey?: string;
}

export interface DiscoveryResult {
  servers: DayZServerProbe[];
  scannedPorts: number[];
  lanScanned: boolean;
  tookMs: number;
}

export type QueryAddressResult =
  | { ok: true; server: DayZServerProbe }
  | { ok: false; reason: 'timeout' | 'dns' | 'mismatch' | 'rejected' | 'rate-limited'; triedPorts: number[] };

interface LocalFolder {
  label: string;
  linkName: string;
  path: string;
}

interface InspectedServer {
  pid: number;
  executablePath: string;
  gamePort: number;
  queryPort: number;
  config: ServerConfigSummary | null;
  workshopMods: ProbeMod[];
  localFolders: LocalFolder[];
  experimental: boolean;
}

interface RegistryEntry {
  pid: number;
  gamePort: number;
  folders: LocalFolder[];
  seenAt: number;
}

/** Local servers a join may name by key. Rebuilt by every discovery. */
const registry = new Map<string, RegistryEntry>();

const LOOPBACK = '127.0.0.1';
const LOOPBACK_TIMEOUT_MS = 800;
const LAN_WINDOW_MS = 1500;
const LAN_QUERY_TIMEOUT_MS = 1500;
const ADDRESS_TIMEOUT_MS = 2500;
const MIN_DISCOVERY_INTERVAL_MS = 3000;
const REGISTRY_TTL_MS = 30 * 60_000;
const MAX_INTERFACES = 8;

// =============================================================================
// Discovery
// =============================================================================

let inFlight: { lan: boolean; promise: Promise<DiscoveryResult> } | null = null;
let lastResult: { lan: boolean; at: number; result: DiscoveryResult } | null = null;

/**
 * Servers on this PC, plus the local network when `lan` is set. Concurrent calls share
 * one run, and a call within 3 s of the last one gets its answer again.
 */
export function discoverLocalServers(options: { lan: boolean }): Promise<DiscoveryResult> {
  if (inFlight && inFlight.lan === options.lan) return inFlight.promise;
  if (lastResult && lastResult.lan === options.lan && Date.now() - lastResult.at < MIN_DISCOVERY_INTERVAL_MS) {
    return Promise.resolve(lastResult.result);
  }
  const promise = runDiscovery(options.lan).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { lan: options.lan, promise };
  return promise;
}

async function runDiscovery(lan: boolean): Promise<DiscoveryResult> {
  const started = Date.now();
  const inspected = await findServerProcesses();

  const ports = [...new Set([...inspected.map(s => s.queryPort), ...LOCAL_QUERY_PORTS])];
  const answers = await Promise.all(ports.map(async port => ({ port, result: await queryDayZServer(LOOPBACK, port, LOOPBACK_TIMEOUT_MS) })));

  const servers: DayZServerProbe[] = [];
  const takenGamePorts = new Set<number>();
  const keepRegistry = new Set<string>();

  // Processes first: they carry the mod folders. Matched to an answer by game port.
  for (const server of inspected) {
    if (takenGamePorts.has(server.gamePort)) continue;
    const answer = answers.find(a => a.result && a.result.info.gamePort === server.gamePort)
      ?? answers.find(a => a.result && a.port === server.queryPort && a.result.info.gamePort === null);
    const key = server.localFolders.length > 0 ? registerLocalServer(server) : undefined;
    if (key) keepRegistry.add(key);
    servers.push(answer?.result
      ? probeFromQuery(LOOPBACK, answer.port, 'process', answer.result, server, key)
      : probeFromProcess(server, key));
    takenGamePorts.add(server.gamePort);
  }

  // Servers that answer on loopback without a process we can see (another user, Docker, WSL).
  for (const { port, result } of answers) {
    const gamePort = result?.info.gamePort;
    if (!result || !gamePort || takenGamePorts.has(gamePort)) continue;
    servers.push(probeFromQuery(LOOPBACK, port, 'loopback', result));
    takenGamePorts.add(gamePort);
  }

  for (const [key, entry] of registry) {
    if (!keepRegistry.has(key) && Date.now() - entry.seenAt > REGISTRY_TTL_MS) registry.delete(key);
  }

  if (lan) servers.push(...await discoverLan());

  // A server that answered without a game port cannot be joined; leave it out rather than
  // fail the whole result's schema check over it.
  const result = { servers: servers.filter(server => server.gamePort > 0), scannedPorts: ports, lanScanned: lan, tookMs: Date.now() - started };
  lastResult = { lan, at: Date.now(), result };
  return result;
}

/** One A2S_INFO broadcast per private interface and port, then a direct query of each responder. */
async function discoverLan(): Promise<DayZServerProbe[]> {
  const interfaces = privateInterfaces();
  if (interfaces.length === 0) return [];
  const ownAddresses = new Set(interfaces.map(i => i.address));
  const targets = interfaces.flatMap(i => LOCAL_QUERY_PORTS.map(port => ({ address: i.broadcast, port })));

  const responders = await broadcastInfo(
    targets,
    LAN_WINDOW_MS,
    address => isPrivateIPv4(address) && !ownAddresses.has(address) && interfaces.some(i => inSubnet(address, i.address, i.netmask))
  );

  const probes: DayZServerProbe[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < responders.length; i += 8) {
    const batch = await Promise.all(responders.slice(i, i + 8).map(async r => ({ r, result: await queryDayZServer(r.address, r.port, LAN_QUERY_TIMEOUT_MS) })));
    for (const { r, result } of batch) {
      const gamePort = result?.info.gamePort;
      if (!result || !gamePort || seen.has(`${r.address}:${gamePort}`)) continue;
      seen.add(`${r.address}:${gamePort}`);
      probes.push(probeFromQuery(r.address, r.port, 'lan', result));
    }
  }
  return probes;
}

function privateInterfaces(): Array<{ address: string; netmask: string; broadcast: string }> {
  const out: Array<{ address: string; netmask: string; broadcast: string }> = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isPrivateIPv4(entry.address)) continue;
      const broadcast = broadcastAddress(entry.address, entry.netmask);
      if (broadcast && out.length < MAX_INTERFACES) out.push({ address: entry.address, netmask: entry.netmask, broadcast });
    }
  }
  return out;
}

// =============================================================================
// One address
// =============================================================================

const lookupTimes: number[] = [];
const LOOKUP_LIMIT = 8;
const LOOKUP_WINDOW_MS = 10_000;

/**
 * Queries the server at `host:gamePort`. Tries at most six query ports in parallel and
 * accepts an answer only when the server's own game port matches the one asked for.
 */
export async function queryAddress(target: { host: string; gamePort: number; queryPortHint?: number }): Promise<QueryAddressResult> {
  const now = Date.now();
  while (lookupTimes.length && now - lookupTimes[0] > LOOKUP_WINDOW_MS) lookupTimes.shift();
  if (lookupTimes.length >= LOOKUP_LIMIT) return { ok: false, reason: 'rate-limited', triedPorts: [] };
  lookupTimes.push(now);

  const ip = await resolveIPv4(target.host);
  if (!ip) return { ok: false, reason: 'dns', triedPorts: [] };
  if (!isQueryableIPv4(ip)) return { ok: false, reason: 'rejected', triedPorts: [] };

  const ports = candidateQueryPorts(target.gamePort, target.queryPortHint);
  const answers = await Promise.all(ports.map(async port => ({ port, result: await queryDayZServer(ip, port, ADDRESS_TIMEOUT_MS) })));
  const match = answers.find(a => a.result && a.result.info.gamePort === target.gamePort)
    ?? answers.find(a => a.result && a.result.info.gamePort === null && a.port === target.queryPortHint);
  if (!match?.result) {
    const mismatch = answers.some(a => a.result);
    return { ok: false, reason: mismatch ? 'mismatch' : 'timeout', triedPorts: ports };
  }

  // A server on this PC typed by address still gets its local mod folders, if discovery saw it.
  const local = isThisMachine(ip) ? findRegistered(target.gamePort) : null;
  const probe = probeFromQuery(ip, match.port, 'address', match.result, undefined, undefined, target.gamePort);
  if (local) {
    probe.unpublishedMods = local.entry.folders.map(folder => ({ name: folder.label }));
    probe.localServerKey = local.key;
  }
  return { ok: true, server: probe };
}

async function resolveIPv4(host: string): Promise<string | null> {
  if (ipv4ToNumber(host) !== null) return host;
  if (host.toLowerCase() === 'localhost') return LOOPBACK;
  try {
    const lookup = dns.promises.lookup(host, { family: 4 });
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 3000));
    const result = await Promise.race([lookup, timeout]);
    return result ? result.address : null;
  } catch {
    return null;
  }
}

// =============================================================================
// Local mods for a join
// =============================================================================

/**
 * The folders a join may load for the server behind `key`, re-checked on disk. Only for
 * a join to that same server on this PC: a key cannot attach folders to any other host.
 * Throws a message the player can act on when the server or a folder is gone.
 */
export async function resolveLocalServerMods(key: string, ip: string, port: number): Promise<Array<{ linkName: string; path: string }>> {
  const entry = registry.get(key);
  if (!entry || entry.gamePort !== port || !isThisMachine(ip)) {
    throw new Error('The local server is no longer known. Refresh Direct Connect and try again.');
  }
  const folders: Array<{ linkName: string; path: string }> = [];
  for (const folder of entry.folders) {
    const stats = await fs.promises.stat(folder.path).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(`The server's mod folder "${folder.label}" is gone. Refresh Direct Connect and try again.`);
    }
    folders.push({ linkName: folder.linkName, path: folder.path });
  }
  return folders;
}

function registerLocalServer(server: InspectedServer): string {
  for (const [key, entry] of registry) {
    if (entry.pid === server.pid && entry.gamePort === server.gamePort) {
      registry.set(key, { ...entry, folders: server.localFolders, seenAt: Date.now() });
      return key;
    }
  }
  const key = randomBytes(16).toString('hex');
  registry.set(key, { pid: server.pid, gamePort: server.gamePort, folders: server.localFolders, seenAt: Date.now() });
  return key;
}

function findRegistered(gamePort: number): { key: string; entry: RegistryEntry } | null {
  for (const [key, entry] of registry) {
    if (entry.gamePort === gamePort) return { key, entry };
  }
  return null;
}

function isThisMachine(ip: string): boolean {
  if (isLoopbackIPv4(ip) || ip === 'localhost') return true;
  return Object.values(os.networkInterfaces()).some(entries => (entries ?? []).some(entry => entry.address === ip));
}

// =============================================================================
// Probes
// =============================================================================

function probeFromQuery(
  ip: string,
  queryPort: number,
  source: ProbeSource,
  answer: DayZQueryResult,
  local?: InspectedServer,
  localServerKey?: string,
  requestedGamePort?: number
): DayZServerProbe {
  const { info, rules } = answer;
  const fromRules = rules ? rules.mods.filter(mod => mod.workshopId > 0) : null;
  return {
    ip,
    // Servers may leave the game port out of A2S_INFO. For an address the player typed it
    // is the port they asked for; a discovered server without one is dropped by the caller
    // (0 would fail the result schema and, in discovery, take every other server with it).
    gamePort: info.gamePort ?? local?.gamePort ?? requestedGamePort ?? 0,
    queryPort,
    source,
    online: true,
    name: info.name || local?.config?.hostname || `${ip}:${info.gamePort ?? queryPort}`,
    map: info.map,
    players: info.players,
    maxPlayers: info.maxPlayers,
    version: info.version,
    appId: info.appId,
    edition: info.appId ? editionFromAppId(info.appId) : (local?.experimental ? 'experimental' : 'stable'),
    passwordProtected: info.passwordProtected || !!local?.config?.hasPassword,
    firstPerson: info.keywords.includes('no3rd'),
    pingMs: answer.pingMs,
    mods: fromRules ?? local?.workshopMods ?? null,
    // On this PC the folders are authoritative; elsewhere the id-0 entries are all we have.
    unpublishedMods: local
      ? local.localFolders.map(folder => ({ name: folder.label }))
      : (rules?.mods.filter(mod => mod.workshopId === 0).map(mod => ({ name: mod.name })) ?? []),
    modsSource: rules ? 'rules' : local ? 'process' : 'none',
    modsComplete: rules ? rules.complete : !!local,
    localServerKey,
  };
}

function probeFromProcess(server: InspectedServer, localServerKey?: string): DayZServerProbe {
  return {
    ip: LOOPBACK,
    gamePort: server.gamePort,
    queryPort: server.queryPort,
    source: 'process',
    online: false,
    name: server.config?.hostname || `DayZServer :${server.gamePort}`,
    map: '',
    players: 0,
    maxPlayers: server.config?.maxPlayers ?? 0,
    version: '',
    appId: null,
    edition: server.experimental ? 'experimental' : 'stable',
    passwordProtected: !!server.config?.hasPassword,
    firstPerson: false,
    pingMs: null,
    mods: server.workshopMods,
    unpublishedMods: server.localFolders.map(folder => ({ name: folder.label })),
    modsSource: 'process',
    modsComplete: true,
    localServerKey,
  };
}

// =============================================================================
// DayZServer processes
// =============================================================================

interface ServerProcess {
  pid: number;
  executablePath: string;
  argv: string[];
  /** Folder relative -config and -mod paths resolve against. */
  baseDir: string;
}

let inspectedCache: { pidKey: string; servers: InspectedServer[] } | null = null;

/**
 * The DayZServer processes on this PC, inspected. Direct Connect rescans every 20 s, and
 * on Windows the full listing means starting PowerShell each time; tasklist names the
 * PIDs for a fraction of that, so the listing and the inspection only run again when the
 * set of PIDs changes. A process's command line and mod folders cannot change under the
 * same PID, so the cached inspection stays right.
 */
async function findServerProcesses(): Promise<InspectedServer[]> {
  const windowsPids = process.platform === 'win32' ? await listWindowsServerPids().catch(() => null) : null;
  if (windowsPids !== null && inspectedCache?.pidKey === windowsPids) return inspectedCache.servers;

  const processes = await listServerProcesses().catch(error => {
    logToFile(`[Direct Connect] Process scan failed: ${(error as Error).message}`);
    return [] as ServerProcess[];
  });
  const pidKey = windowsPids ?? pidKeyOf(processes.map(proc => proc.pid));
  if (inspectedCache?.pidKey === pidKey) return inspectedCache.servers;

  const servers = (await Promise.all(processes.map(inspectProcess))).filter((s): s is InspectedServer => !!s);
  inspectedCache = { pidKey, servers };
  return servers;
}

async function listWindowsServerPids(): Promise<string> {
  const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq DayZServer*', '/FO', 'CSV', '/NH'], {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 256 * 1024,
  });
  return pidKeyOf(parseTasklistPids(stdout));
}

async function listServerProcesses(): Promise<ServerProcess[]> {
  if (process.platform === 'win32') return listWindowsProcesses();
  if (process.platform === 'linux') return listLinuxProcesses();
  return [];
}

/** CIM through PowerShell, the same route platform-utils uses: tasklist has no command lines. */
async function listWindowsProcesses(): Promise<ServerProcess[]> {
  const script = "Get-CimInstance Win32_Process -Filter \"Name like 'DayZServer%'\" | " +
    'Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ ProcessId?: number; ExecutablePath?: string | null; CommandLine?: string | null }>;
  return rows.slice(0, 16).flatMap(row => {
    // CommandLine is null for an elevated server seen from a non-elevated launcher; the
    // loopback probe still finds it, just without its mod folders.
    if (!row.ProcessId || !row.ExecutablePath || !row.CommandLine) return [];
    return [{
      pid: row.ProcessId,
      executablePath: row.ExecutablePath,
      argv: tokenizeCommandLine(row.CommandLine).slice(1),
      baseDir: path.dirname(row.ExecutablePath),
    }];
  });
}

async function listLinuxProcesses(): Promise<ServerProcess[]> {
  const entries = await fs.promises.readdir('/proc');
  const found: ServerProcess[] = [];
  for (const entry of entries.slice(0, 32_768)) {
    if (!/^\d+$/.test(entry) || found.length >= 16) continue;
    const dir = `/proc/${entry}`;
    const comm = await fs.promises.readFile(`${dir}/comm`, 'utf8').catch(() => '');
    // comm is cut at 15 characters: "DayZServer" natively, "DayZServer_x64." under Wine
    if (!comm.startsWith('DayZServer')) continue;
    const cmdline = await fs.promises.readFile(`${dir}/cmdline`, 'utf8').catch(() => '');
    const argv = cmdline.split('\0').filter(Boolean);
    if (argv.length === 0) continue;
    const executablePath = await fs.promises.readlink(`${dir}/exe`).catch(() => argv[0]);
    const cwd = await fs.promises.readlink(`${dir}/cwd`).catch(() => null);
    found.push({ pid: Number(entry), executablePath, argv: argv.slice(1), baseDir: cwd ?? path.dirname(executablePath) });
  }
  return found;
}

async function inspectProcess(proc: ServerProcess): Promise<InspectedServer | null> {
  try {
    const args = readServerArgs(proc.argv);
    const configPath = path.resolve(proc.baseDir, args.configPath ?? 'serverDZ.cfg');
    const config = await readSmallFile(configPath, 256 * 1024).then(text => (text === null ? null : parseServerConfig(text)));

    const workshopMods: ProbeMod[] = [];
    const localFolders: LocalFolder[] = [];
    const linkNames = new Set<string>();
    for (const entry of args.modEntries.slice(0, MAX_SERVER_MODS)) {
      const folderPath = path.resolve(proc.baseDir, entry);
      const folderName = path.basename(folderPath);
      const stats = await fs.promises.stat(folderPath).catch(() => null);
      if (!stats?.isDirectory()) continue;

      const meta = await readSmallFile(path.join(folderPath, 'meta.cpp'), 64 * 1024);
      const workshopId = workshopIdFromFolderName(folderName) ?? (meta ? parsePublishedId(meta) : null);
      if (workshopId) {
        workshopMods.push({ workshopId, name: (meta && parseModDisplayName(meta)) || modLabelFromFolder(folderName) });
        continue;
      }
      const modCpp = await readSmallFile(path.join(folderPath, 'mod.cpp'), 64 * 1024);
      let linkName = localModLinkName(folderName);
      for (let n = 2; linkNames.has(linkName); n++) linkName = `${localModLinkName(folderName)}_${n}`;
      linkNames.add(linkName);
      localFolders.push({ label: (modCpp && parseModDisplayName(modCpp)) || modLabelFromFolder(folderName), linkName, path: folderPath });
    }

    return {
      pid: proc.pid,
      executablePath: proc.executablePath,
      gamePort: args.gamePort,
      queryPort: config?.steamQueryPort ?? DEFAULT_STEAM_QUERY_PORT,
      config,
      workshopMods,
      localFolders,
      experimental: isExperimentalServerPath(proc.executablePath),
    };
  } catch (error) {
    logToFile(`[Direct Connect] Could not inspect DayZServer process ${proc.pid}: ${(error as Error).message}`);
    return null;
  }
}

async function readSmallFile(filePath: string, maxBytes: number): Promise<string | null> {
  const stats = await fs.promises.stat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.size > maxBytes) return null;
  return fs.promises.readFile(filePath, 'utf8').catch(() => null);
}
