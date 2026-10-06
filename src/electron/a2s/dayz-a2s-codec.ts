/**
 * Steam server query (A2S) packets for DayZ: building requests, reassembling split
 * replies, and decoding A2S_INFO and the DayZ binary payload inside A2S_RULES.
 *
 * WHY THIS EXISTS
 * ===============
 * A DayZ server advertises the mods a client needs in A2S_RULES, as an escaped binary
 * blob spread over two-byte rule keys. gamedig parses it with a fixed four-byte id and
 * no separation between mods and signatures, so a single mod that is not on the
 * Workshop (id length 0) shifts every entry after it. The backend's decoder
 * (a2s-java-lib DayzProtocol.decodeDayzRules) reads the id-length nibble and the
 * signature section properly; this is a port of it, checked against live servers.
 *
 * Pure byte work only (no dgram, no Buffer, no electron) so it runs under the Karma spec
 * runner on captured replies. a2s-client.ts does the networking.
 *
 * Every read is bounds-checked and every size is capped: replies come from whatever
 * answers on a UDP port, so a malformed or hostile one must fail cleanly.
 */
import { GAME_EDITIONS } from '../dayz-install-locator';

/** Ceilings for what a reply may make us hold. Real DayZ rules replies are 0.3-2 KB. */
export const A2S_LIMITS = {
  /** Packets in one split reply. */
  maxPackets: 16,
  /** Bytes of one reassembled reply. */
  maxBytes: 64 * 1024,
  /** Mods kept from one server. The payload's own count is a single byte. */
  maxMods: 255,
  /** Characters kept from a server-supplied string (names, map, version). */
  maxText: 256,
} as const;

/** The Steam app ids a DayZ server reports in its A2S_INFO GameID. */
export const DAYZ_APP_IDS = {
  stable: Number(GAME_EDITIONS.stable.appId),
  experimental: Number(GAME_EDITIONS.experimental.appId),
} as const;

export type GameEditionKey = 'stable' | 'experimental';

/** Which client a server needs, from the app id in its A2S_INFO. Unknown means stable. */
export function editionFromAppId(appId: number | null | undefined): GameEditionKey {
  return appId === DAYZ_APP_IDS.experimental ? 'experimental' : 'stable';
}

const HEADER_SINGLE = 0xffffffff | 0; // -1 as int32
const HEADER_SPLIT = 0xfffffffe | 0; // -2 as int32

const TYPE_CHALLENGE = 0x41;
const TYPE_INFO = 0x49;
const TYPE_RULES = 0x45;

const NO_CHALLENGE = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
const INFO_PAYLOAD = 'Source Engine Query\0';

/** Raised for any reply that is truncated, oversized or not what was asked for. */
export class A2SDecodeError extends Error {}

// --------------------------------------------------------------------------------------
// Requests
// --------------------------------------------------------------------------------------

/** A2S_INFO request. Servers since 2020 answer the first one with a challenge to echo. */
export function infoRequest(challenge?: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(INFO_PAYLOAD);
  const tail = challenge ?? new Uint8Array(0);
  const out = new Uint8Array(5 + text.length + tail.length);
  out.set([0xff, 0xff, 0xff, 0xff, 0x54]);
  out.set(text, 5);
  out.set(tail, 5 + text.length);
  return out;
}

/** A2S_RULES request; the first one carries -1 and is answered with a challenge. */
export function rulesRequest(challenge?: Uint8Array): Uint8Array {
  const out = new Uint8Array(9);
  out.set([0xff, 0xff, 0xff, 0xff, 0x56]);
  out.set(challenge ?? NO_CHALLENGE, 5);
  return out;
}

// --------------------------------------------------------------------------------------
// Reply framing
// --------------------------------------------------------------------------------------

export type A2SReply =
  | { kind: 'challenge'; challenge: Uint8Array }
  | { kind: 'info'; body: Uint8Array }
  | { kind: 'rules'; body: Uint8Array };

/** Reads a complete single-packet reply (`FF FF FF FF <type> ...`); null for anything else. */
export function classifyReply(packet: Uint8Array): A2SReply | null {
  if (packet.length < 5 || readInt32(packet, 0) !== HEADER_SINGLE) return null;
  const body = packet.subarray(5);
  switch (packet[4]) {
    case TYPE_CHALLENGE:
      return body.length >= 4 ? { kind: 'challenge', challenge: body.slice(0, 4) } : null;
    case TYPE_INFO:
      return { kind: 'info', body };
    case TYPE_RULES:
      return { kind: 'rules', body };
    default:
      return null;
  }
}

/**
 * Reassembles a split reply (Source format: id, total, number, max size).
 *
 * `push` takes every datagram received for one request. It returns the full packet once
 * a single-packet reply or the last fragment arrives, and null while fragments are
 * missing. Compressed (bzip2) replies are refused: DayZ does not send them, and nothing
 * here should decompress attacker-sized input.
 */
export class SplitAssembler {
  private parts = new Map<number, Uint8Array>();
  private total = 0;
  private id: number | null = null;
  private bytes = 0;

  push(datagram: Uint8Array): Uint8Array | null {
    if (datagram.length < 4) throw new A2SDecodeError('datagram too short');
    const header = readInt32(datagram, 0);
    if (header === HEADER_SINGLE) {
      if (datagram.length > A2S_LIMITS.maxBytes) throw new A2SDecodeError('reply too large');
      return datagram;
    }
    if (header !== HEADER_SPLIT) throw new A2SDecodeError('not an A2S reply');
    if (datagram.length < 12) throw new A2SDecodeError('split header truncated');

    const id = readInt32(datagram, 4);
    if (id & 0x80000000) throw new A2SDecodeError('compressed replies are not supported');
    const total = datagram[8];
    const number = datagram[9];
    if (total === 0 || total > A2S_LIMITS.maxPackets || number >= total) {
      throw new A2SDecodeError('split packet count out of range');
    }
    if (this.id === null) {
      this.id = id;
      this.total = total;
    } else if (id !== this.id || total !== this.total) {
      // A fragment of some other reply (a retransmission of an older request): ignore it.
      return null;
    }
    if (this.parts.has(number)) return null;

    const payload = datagram.subarray(12);
    this.bytes += payload.length;
    if (this.bytes > A2S_LIMITS.maxBytes) throw new A2SDecodeError('reply too large');
    this.parts.set(number, payload);
    if (this.parts.size < this.total) return null;

    const out = new Uint8Array(this.bytes);
    let offset = 0;
    for (let i = 0; i < this.total; i++) {
      const part = this.parts.get(i)!;
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

// --------------------------------------------------------------------------------------
// A2S_INFO
// --------------------------------------------------------------------------------------

export interface A2SInfo {
  name: string;
  map: string;
  folder: string;
  game: string;
  players: number;
  maxPlayers: number;
  passwordProtected: boolean;
  version: string;
  /** Port players connect on (EDF 0x80). Null when the server does not send it. */
  gamePort: number | null;
  /** App id from the 64-bit GameID (EDF 0x01): 221100 stable, 1024020 Experimental. */
  appId: number | null;
  keywords: string[];
}

/** Decodes an A2S_INFO body (the bytes after the 0x49 type byte). */
export function parseInfo(body: Uint8Array): A2SInfo {
  const reader = new Reader(body);
  reader.u8(); // protocol
  const name = reader.cstring();
  const map = reader.cstring();
  const folder = reader.cstring();
  const game = reader.cstring();
  reader.u16(); // 16-bit app id, truncated for DayZ
  const players = reader.u8();
  const maxPlayers = reader.u8();
  reader.u8(); // bots
  reader.u8(); // server type
  reader.u8(); // environment
  const passwordProtected = reader.u8() === 1;
  reader.u8(); // VAC
  const version = reader.cstring();

  let gamePort: number | null = null;
  let appId: number | null = null;
  let keywords: string[] = [];
  if (reader.remaining() > 0) {
    const edf = reader.u8();
    if (edf & 0x80) gamePort = reader.u16();
    if (edf & 0x10) reader.skip(8); // server SteamID
    if (edf & 0x40) {
      reader.u16(); // SourceTV port
      reader.cstring(); // SourceTV name
    }
    if (edf & 0x20) keywords = reader.cstring().split(',').filter(Boolean).slice(0, 64);
    if (edf & 0x01) {
      // GameID: the app id is its low 24 bits. Read the low dword only; the high one
      // holds mod and type bits we do not need.
      appId = reader.u32() & 0xffffff;
      reader.skip(4);
    }
  }

  return {
    name, map, folder, game, players, maxPlayers, passwordProtected, version,
    gamePort: gamePort || null,
    // The 16-bit app id field cannot hold 221100 (DayZ sends it truncated), so only the
    // GameID counts.
    appId: appId || null,
    keywords,
  };
}

// --------------------------------------------------------------------------------------
// A2S_RULES and the DayZ payload
// --------------------------------------------------------------------------------------

export interface A2SRules {
  /** Ordinary text rules (allowedBuild, dedicated, island, ...). */
  rules: Record<string, string>;
  /** The DayZ binary payload chunks, keyed by their two-byte rule key (little endian). */
  chunks: Array<{ key: number; value: Uint8Array }>;
}

/** Decodes an A2S_RULES body (the bytes after the 0x45 type byte). */
export function parseRules(body: Uint8Array): A2SRules {
  const reader = new Reader(body);
  const count = reader.u16();
  const rules: Record<string, string> = {};
  const chunks: A2SRules['chunks'] = [];
  for (let i = 0; i < count && reader.remaining() > 0; i++) {
    const key = reader.cbytes();
    const value = reader.cbytes();
    if (key.length === 2) {
      // DayZ escapes zero bytes out of its payload, so both key bytes are non-zero and a
      // two-byte key can only be a payload chunk; no text rule is two characters long.
      chunks.push({ key: key[0] | (key[1] << 8), value });
    } else if (Object.keys(rules).length < 64) {
      rules[decodeText(key)] = decodeText(value);
    }
  }
  return { rules, chunks };
}

export interface DayZRulesMod {
  /** Steam Workshop id; 0 when the mod is not published on the Workshop. */
  workshopId: number;
  name: string;
}

export interface DayZRulesPayload {
  protocolVersion: number;
  /** False when the server flagged an overflow: its list did not fit and is cut short. */
  complete: boolean;
  mods: DayZRulesMod[];
  /** Key names the server accepts (`VPP`, `cftoolsRoot`...); not mods. */
  signatures: string[];
}

/**
 * Decodes the DayZ payload carried in the rule chunks: sort by key, concatenate,
 * unescape (01 01 -> 01, 01 02 -> 00, 01 03 -> FF), then version, overflow flags, DLC
 * flags, DLC hashes, the mod list (hash, id length nibble, id, name) and signatures.
 */
export function decodeDayZRules(chunks: A2SRules['chunks']): DayZRulesPayload {
  const sorted = [...chunks].sort((a, b) => a.key - b.key);
  const joined = concat(sorted.map(chunk => chunk.value));
  const reader = new Reader(unescapePayload(joined));

  const protocolVersion = reader.u8();
  const overflow = reader.u8();
  const dlcFlags = reader.u16();
  reader.skip(4 * popcount(dlcFlags));

  const mods: DayZRulesMod[] = [];
  const modCount = reader.u8();
  for (let i = 0; i < modCount; i++) {
    reader.skip(4); // mod hash
    const idLength = reader.u8() & 0x0f;
    if (idLength > 8) throw new A2SDecodeError('workshop id too long');
    let workshopId = 0;
    const idBytes = reader.bytes(idLength);
    for (let j = idBytes.length - 1; j >= 0; j--) workshopId = workshopId * 256 + idBytes[j];
    const name = decodeText(reader.bytes(reader.u8()));
    if (mods.length < A2S_LIMITS.maxMods) mods.push({ workshopId, name });
  }

  const signatures: string[] = [];
  if (reader.remaining() > 0) {
    const signatureCount = reader.u8();
    for (let i = 0; i < signatureCount && reader.remaining() > 0; i++) {
      signatures.push(decodeText(reader.bytes(reader.u8())));
    }
  }

  return { protocolVersion, complete: overflow === 0, mods, signatures };
}

/** Reverses DayZ's escaping. Done in one pass so an escaped 01 is never re-read. */
export function unescapePayload(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x01 && i + 1 < bytes.length) {
      const next = bytes[i + 1];
      if (next === 0x01 || next === 0x02 || next === 0x03) {
        out[length++] = next === 0x01 ? 0x01 : next === 0x02 ? 0x00 : 0xff;
        i++;
        continue;
      }
    }
    out[length++] = bytes[i];
  }
  return out.subarray(0, length);
}

// --------------------------------------------------------------------------------------
// Byte helpers
// --------------------------------------------------------------------------------------

class Reader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  remaining(): number {
    return this.data.length - this.offset;
  }

  skip(count: number): void {
    this.need(count);
    this.offset += count;
  }

  u8(): number {
    this.need(1);
    return this.data[this.offset++];
  }

  u16(): number {
    this.need(2);
    const value = this.data[this.offset] | (this.data[this.offset + 1] << 8);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = readInt32(this.data, this.offset) >>> 0;
    this.offset += 4;
    return value;
  }

  bytes(count: number): Uint8Array {
    this.need(count);
    const out = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  /** Bytes up to the next zero, which is consumed. A missing terminator is an error. */
  cbytes(): Uint8Array {
    const end = this.data.indexOf(0, this.offset);
    if (end < 0) throw new A2SDecodeError('unterminated string');
    const out = this.data.subarray(this.offset, end);
    this.offset = end + 1;
    return out;
  }

  cstring(): string {
    return decodeText(this.cbytes());
  }

  private need(count: number): void {
    if (count < 0 || this.offset + count > this.data.length) throw new A2SDecodeError('reply truncated');
  }
}

const textDecoder = new TextDecoder('utf-8');

function decodeText(bytes: Uint8Array): string {
  // Server names arrive with stray control characters and trailing newlines.
  return textDecoder.decode(bytes).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, A2S_LIMITS.maxText);
}

function readInt32(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function popcount(value: number): number {
  let count = 0;
  for (let v = value; v; v >>>= 1) count += v & 1;
  return count;
}
