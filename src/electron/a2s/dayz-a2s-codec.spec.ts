import {
  A2SDecodeError,
  A2S_LIMITS,
  SplitAssembler,
  classifyReply,
  decodeDayZRules,
  editionFromAppId,
  infoRequest,
  parseInfo,
  parseRules,
  rulesRequest,
  unescapePayload,
} from './dayz-a2s-codec';

/**
 * Replies captured from two live public DayZ servers (2026-10-03) with the prototype in
 * the Direct Connect proposal: the bytes after the A2S type byte. Their Workshop ids were
 * checked against the DayZ Beans backend's mod list for the same servers.
 */
const RULES_LARGE = fromBase64(
  'EQABCAACAQIBAgECFBhAmMkE4BC8rhVGb3J3YXJkIE9wZXJhdG9yIEdlYXKbSI2fBF3qa5QTUmVhcm1lZCBTZXJ2ZXIgUGFja37Z' +
  'p90EdnWQrRBSZWFybWVkIExpY2Vuc2VkIh+5IwSbh/OtE1N1cnZpdm9yIEFuaW1hdGlvbnOc6f69AAIIAASPMzSXFlNreVogLSBT' +
  'a3lib3ggT3ZlcmhhdWw/LBABAQSjWvyRDk1hZ09iZnVzY2F0aW9uaxDxXQRfQbCRE0ludmVudG9yeU1vdmVTb3VuZHOnLucQBCCe' +
  'tpcORGFicyBGcmFtZXdvcmseeyopBOOY86oUR1NDIEdhbWV3b3IAAwgAbGQgQXNzZXRzeYTxcwSlBwaeHUFybWEgMiBIZWxpY29w' +
  'dGVycyBSZW1hc3RlcmVkXQnDHAQ1hnmmEURheVotRXhwYW5zaW9uLUFJYdBjDwRxjnmmF0RheVotRXhwYW5zaW9uLU1pc3Npb25z' +
  'Wu+DMwTkSpeoF0RheVotRXhwYQAECABuc2lvbi1IYXJkbGluZQYW1+0EoUiXqBVEYXlaLUV4cGFuc2lvbi1RdWVzdHO/NeQuBBae' +
  'UpkVRGF5Wi1FeHBhbnNpb24tTWFya2V0ct4itQSKAQMhfhdEYXlaLUV4cGFuc2lvbi1MaWNlbnNlZMwVeKcE3d6ZiBdEYXlaLUV4' +
  'AAUIAHBhbnNpb24tVmVoaWNsZXMXhIZUBFzemYgTRGF5Wi1FeHBhbnNpb24tQ29yZYMarIIEnaBwyhRJdHNBVHJlZWUgRmFjZVBh' +
  'aW50c8HGr2gEBLDvXBNDb21tdW5pdHkgRnJhbWV3b3JrEgthZmZlbmIzcnRWMgRBSjQ1C2NmdG8ABggAb2xzUm9vdAVjeW5lcANk' +
  'YWIEZGF5eglkZXNpZ25mdWwJRXhwYW5zaW9uEUZyb3N0Yml0ZU9mZmljaWFsB0h1bnRlcnoMSW5jbGVtZW50RGFiC0l0c0FUcmVl' +
  'ZXYyDkphY29iX01hbmdvX1YzCUpvc2VjaXRveARMNERTCmxpcQAHCAB1aWRyb2NrBnJ1ZmZhegNWUFCrRXNjYXBlIGZyb20gVGFy' +
  'a292IGluc3BpcmVkIGFuZCBjcmVhdGVkIGZyb20gdGhlIGJvdHRvbSB1cCBhcyB0aGUgbW9zdCBwcm9ncmVzc2l2ZSBEYXlaIFN0' +
  'YW5kYWxvbmUgbW9kZGVkIHNlAAgIAHJ2ZXIuIFRoaXMgaXMgdGhlIG5ldyBEYXlaIHN0YW5kYXJkLiBodHRwczovL2Rpc2NvcmQu' +
  'Z2cvcmVhcm1lZABhbGxvd2VkQnVpbGQAMABjbGllbnRQb3J0ADAAZGVkaWNhdGVkADEAaXNsYW5kAENoZXJuYXJ1c1BsdXMAbGFu' +
  'Z3VhZ2UANjU1NDUAcGxhdGZvcm0Ad2luAHJlcXVpcmVkQnVpbGQAMAByZXF1aXJlZFZlcnNpb24AMTI5AHRpbWVMZWZ0ADE1AA==');
const INFO_LARGE = fromBase64(
  'EVJlYXJtZWQgRVU0IHwgU29sbyBEdW8gVHJpbwBDaGVybmFydXNQbHVzAGRheXoARXNjYXBlIGZyb20gVGFya292IGluc3BpcmVk' +
  'IGFuZCBjcmVhdGVkIGZyb20gdGhlIGJvdHRvbSB1cCBhcyB0AAAAb3kAZHcAATEuMjkuMTYzNzA5ALH+CBVEeSziyUABYmF0dGxl' +
  'eWUsbm8zcmQsZXh0ZXJuYWwscHJpdkhpdmUsc2hhcmQxMjNBQkMsbHFzMjEsZXRtNi4wMDAwMDAsZW50bTUuMDAwMDAwLG1vZCwx' +
  'MDoxMQCsXwMAAAAAAA==');
const RULES_SMALL = fromBase64(
  'CwABAgACAQIBAgECAyuLen8E3VNBrwhTdWV0YSBSVRsY2x4E6tQeYghDb2RlTG9ja8HGr2gEBLDvXBNDb21tdW5pdHkgRnJhbWV3' +
  'b3JrCgtjZnRvb2xzUm9vdApDb2RlTG9ja3YzBGRheXoJZGVzaWduZnVsB0h1bnRlcnoMSW5jbGVtAAICAGVudERhYg5KYWNvYl9N' +
  'YW5nb19WMwZteXJ0YW4DVlBQCVdhcmRvZy52MwECAGFsbG93ZWRCdWlsZAAwAGNsaWVudFBvcnQAMABkZWRpY2F0ZWQAMQBpc2xh' +
  'bmQAY2hlcm5hcnVzcGx1cwBsYW5ndWFnZQA2NTU2MQBwbGF0Zm9ybQB3aW4AcmVxdWlyZWRCdWlsZAAwAHJlcXVpcmVkVmVyc2lv' +
  'bgAxMjkAdGltZUxlZnQAMTUA');
const INFO_SMALL = fromBase64(
  'EVNVRVRBIFJVIHwgM1BQIHwgUFZQIE1PUkUgTE9PVCB8IFdJUEUgMTIuMDkAY2hlcm5hcnVzcGx1cwBkYXl6AAAAAHh4AGR3AAEx' +
  'LjI5LjE2MzcwOQCx/ggMhCPq68lAAWJhdHRsZXllLGV4dGVybmFsLHByaXZIaXZlLHNoYXJkMTIzQUJDLGxxczEwLGV0bTIuMDAw' +
  'MDAwLGVudG0yNC4wMDAwMDAsbW9kLDE3OjQzAKxfAwAAAAAA');

describe('dayz-a2s-codec', () => {
  describe('captured replies', () => {
    it('decodes the info of a modded stable server, game port and app id included', () => {
      const info = parseInfo(INFO_LARGE);

      expect(info.name).toBe('Rearmed EU4 | Solo Duo Trio');
      expect(info.map).toBe('ChernarusPlus');
      expect(info.players).toBe(111);
      expect(info.maxPlayers).toBe(121);
      expect(info.version).toBe('1.29.163709');
      expect(info.gamePort).toBe(2302);
      expect(info.appId).toBe(221100);
      expect(info.passwordProtected).toBeFalse();
      expect(info.keywords).toContain('no3rd');
    });

    it('reads exactly the Workshop mods the backend lists, apart from the signatures', () => {
      const { rules, chunks } = parseRules(RULES_LARGE);
      const payload = decodeDayZRules(chunks);

      expect(rules['island']).toBe('ChernarusPlus');
      expect(payload.protocolVersion).toBe(2);
      expect(payload.complete).toBeTrue();
      expect(payload.mods.map(mod => mod.workshopId).sort()).toEqual([
        1559212036, 2116157322, 2291785308, 2291785437, 2444247391, 2449234595, 2490100317,
        2536780687, 2545327648, 2572328470, 2651195301, 2792982069, 2792984177, 2828486817,
        2828487396, 2868091107, 2911925622, 2918418331, 2931560672, 3396378781,
      ]);
      expect(payload.mods[0]).toEqual({ workshopId: 2931560672, name: 'Forward Operator Gear' });
      expect(payload.signatures.length).toBe(18);
      expect(payload.signatures).toContain('cftoolsRoot');
    });

    it('decodes a small mod list', () => {
      const payload = decodeDayZRules(parseRules(RULES_SMALL).chunks);

      expect(payload.mods).toEqual([
        { workshopId: 2940294109, name: 'Sueta RU' },
        { workshopId: 1646187754, name: 'CodeLock' },
        { workshopId: 1559212036, name: 'Community Framework' },
      ]);
      expect(payload.signatures.length).toBe(10);
      expect(parseInfo(INFO_SMALL).players).toBe(120);
    });

    it('decodes the same list whatever order the chunks arrive in', () => {
      const { chunks } = parseRules(RULES_LARGE);
      const shuffled = [...chunks].reverse();

      expect(decodeDayZRules(shuffled).mods).toEqual(decodeDayZRules(chunks).mods);
    });
  });

  describe('editions', () => {
    it('reads the Experimental app id from the GameID', () => {
      const info = parseInfo(infoBody({ appId: 1024020, gamePort: 2402, version: '1.30.164014' }));

      expect(info.appId).toBe(1024020);
      expect(info.gamePort).toBe(2402);
      expect(editionFromAppId(info.appId)).toBe('experimental');
    });

    it('treats a server without a GameID as stable', () => {
      const info = parseInfo(infoBody({ appId: null, gamePort: null }));

      expect(info.appId).toBeNull();
      expect(info.gamePort).toBeNull();
      expect(editionFromAppId(info.appId)).toBe('stable');
      expect(editionFromAppId(221100)).toBe('stable');
    });

    it('reports the password flag', () => {
      expect(parseInfo(infoBody({ password: true })).passwordProtected).toBeTrue();
    });
  });

  describe('DayZ payload', () => {
    it('keeps a mod that is not on the Workshop (id length 0) without shifting the next ones', () => {
      const payload = decodeDayZRules(rulesChunks(payloadBytes([
        { id: 1559212036, name: 'CF' },
        { id: 0, name: 'jp_client' },
        { id: 1646187754, name: 'Code Lock' },
      ], ['VPP'])));

      expect(payload.mods).toEqual([
        { workshopId: 1559212036, name: 'CF' },
        { workshopId: 0, name: 'jp_client' },
        { workshopId: 1646187754, name: 'Code Lock' },
      ]);
      expect(payload.signatures).toEqual(['VPP']);
    });

    it('flags an overflowing list as incomplete', () => {
      const payload = decodeDayZRules(rulesChunks(payloadBytes([{ id: 1559212036, name: 'CF' }], [], 1)));

      expect(payload.complete).toBeFalse();
    });

    it('skips the DLC hashes announced by the DLC flags', () => {
      const payload = decodeDayZRules(rulesChunks(payloadBytes([{ id: 1559212036, name: 'CF' }], [], 0, 0b11)));

      expect(payload.mods).toEqual([{ workshopId: 1559212036, name: 'CF' }]);
    });

    it('unescapes in one pass', () => {
      expect([...unescapePayload(new Uint8Array([0x01, 0x01, 0x02, 0x01, 0x02, 0x01, 0x03, 0x05]))])
        .toEqual([0x01, 0x02, 0x00, 0xff, 0x05]);
    });

    it('refuses a truncated payload instead of reading past it', () => {
      const bytes = payloadBytes([{ id: 1559212036, name: 'Community Framework' }], []);
      const truncated = bytes.subarray(0, bytes.length - 12);

      expect(() => decodeDayZRules(rulesChunks(truncated))).toThrowError(A2SDecodeError);
    });
  });

  describe('framing', () => {
    it('builds the A2S_INFO and A2S_RULES requests, with and without a challenge', () => {
      const challenge = new Uint8Array([1, 2, 3, 4]);

      expect([...infoRequest().subarray(0, 5)]).toEqual([0xff, 0xff, 0xff, 0xff, 0x54]);
      expect(new TextDecoder().decode(infoRequest().subarray(5))).toBe('Source Engine Query\0');
      expect([...infoRequest(challenge).subarray(-4)]).toEqual([1, 2, 3, 4]);
      expect([...rulesRequest()]).toEqual([0xff, 0xff, 0xff, 0xff, 0x56, 0xff, 0xff, 0xff, 0xff]);
      expect([...rulesRequest(challenge).subarray(5)]).toEqual([1, 2, 3, 4]);
    });

    it('classifies challenge, info and rules replies and ignores anything else', () => {
      expect(classifyReply(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x41, 9, 8, 7, 6]))).toEqual(
        { kind: 'challenge', challenge: new Uint8Array([9, 8, 7, 6]) });
      expect(classifyReply(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x49, 1]))?.kind).toBe('info');
      expect(classifyReply(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x45, 0, 0]))?.kind).toBe('rules');
      expect(classifyReply(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x6d]))).toBeNull();
      expect(classifyReply(new Uint8Array([1, 2, 3]))).toBeNull();
    });

    it('reassembles split packets in any order', () => {
      const whole = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x45, 1, 2, 3, 4, 5, 6]);
      const assembler = new SplitAssembler();

      expect(assembler.push(fragment(7, 3, 2, whole.subarray(8)))).toBeNull();
      expect(assembler.push(fragment(7, 3, 0, whole.subarray(0, 4)))).toBeNull();
      expect(assembler.push(fragment(7, 3, 0, whole.subarray(0, 4)))).toBeNull(); // duplicate
      expect(assembler.push(fragment(99, 3, 1, new Uint8Array([0xaa])))).toBeNull(); // another reply
      expect(assembler.push(fragment(7, 3, 1, whole.subarray(4, 8)))).toEqual(whole);
    });

    it('passes a single-packet reply through', () => {
      const packet = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x49, 0]);

      expect(new SplitAssembler().push(packet)).toBe(packet);
    });

    it('refuses compressed, oversized and out-of-range split replies', () => {
      expect(() => new SplitAssembler().push(fragment(0x80000001 | 0, 2, 0, new Uint8Array(4))))
        .toThrowError(A2SDecodeError, /compressed/);
      expect(() => new SplitAssembler().push(fragment(1, A2S_LIMITS.maxPackets + 1, 0, new Uint8Array(4))))
        .toThrowError(A2SDecodeError);
      expect(() => new SplitAssembler().push(fragment(1, 2, 2, new Uint8Array(4)))).toThrowError(A2SDecodeError);

      const big = new SplitAssembler();
      expect(big.push(fragment(1, 2, 0, new Uint8Array(A2S_LIMITS.maxBytes - 10)))).toBeNull();
      expect(() => big.push(fragment(1, 2, 1, new Uint8Array(20)))).toThrowError(A2SDecodeError, /too large/);
    });

    it('refuses an info reply cut in the middle of a string', () => {
      expect(() => parseInfo(infoBody({}).subarray(0, 10))).toThrowError(A2SDecodeError);
    });
  });
});

// --- helpers --------------------------------------------------------------------------

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function cstr(text: string): number[] {
  return [...new TextEncoder().encode(text), 0];
}

function le(value: number, bytes: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes; i++) out.push(Math.floor(value / 2 ** (8 * i)) % 256);
  return out;
}

function infoBody(opts: { appId?: number | null; gamePort?: number | null; version?: string; password?: boolean }): Uint8Array {
  const appId = opts.appId === undefined ? 221100 : opts.appId;
  const gamePort = opts.gamePort === undefined ? 2302 : opts.gamePort;
  const edf = (gamePort ? 0x80 : 0) | 0x20 | (appId ? 0x01 : 0);
  return new Uint8Array([
    17, ...cstr('Test server'), ...cstr('sakhal'), ...cstr('dayz'), ...cstr('DayZ'), ...le(appId ?? 0, 2),
    0, 10, 0, 0x64, 0x77, opts.password ? 1 : 0, 0, ...cstr(opts.version ?? '1.29.163709'), edf,
    ...(gamePort ? le(gamePort, 2) : []), ...cstr('battleye,no3rd'), ...(appId ? [...le(appId, 4), 0, 0, 0, 0] : []),
  ]);
}

/** Unescaped DayZ payload, as the server builds it before escaping. */
function payloadBytes(mods: { id: number; name: string }[], signatures: string[], overflow = 0, dlcFlags = 0): Uint8Array {
  const out = [2, overflow, ...le(dlcFlags, 2)];
  for (let i = 0; i < [...dlcFlags.toString(2)].filter(bit => bit === '1').length; i++) out.push(0x10, 0x20, 0x30, 0x40);
  out.push(mods.length);
  for (const mod of mods) {
    const idBytes = mod.id ? le(mod.id, 4) : [];
    const name = [...new TextEncoder().encode(mod.name)];
    out.push(0xde, 0xad, 0xbe, 0xef, idBytes.length, ...idBytes, name.length, ...name);
  }
  out.push(signatures.length);
  for (const signature of signatures) {
    const name = [...new TextEncoder().encode(signature)];
    out.push(name.length, ...name);
  }
  return new Uint8Array(out);
}

/** Escapes a payload and spreads it over two-byte keyed chunks, as DayZ does. */
function rulesChunks(payload: Uint8Array): Array<{ key: number; value: Uint8Array }> {
  const escaped: number[] = [];
  for (const byte of payload) {
    if (byte === 0x01) escaped.push(0x01, 0x01);
    else if (byte === 0x00) escaped.push(0x01, 0x02);
    else if (byte === 0xff) escaped.push(0x01, 0x03);
    else escaped.push(byte);
  }
  const chunks: Array<{ key: number; value: Uint8Array }> = [];
  for (let i = 0, n = 0; i < escaped.length; n++) {
    // Never split an escape pair across chunks
    let end = Math.min(i + 7, escaped.length);
    if (escaped[end - 1] === 0x01 && end < escaped.length) end++;
    chunks.push({ key: (n + 1) | (2 << 8), value: new Uint8Array(escaped.slice(i, end)) });
    i = end;
  }
  // Round trip through the A2S_RULES body format, so parseRules is exercised as well
  const body = [...le(chunks.length, 2)];
  for (const chunk of chunks) body.push(chunk.key & 0xff, chunk.key >> 8, 0, ...chunk.value, 0);
  return parseRules(new Uint8Array(body)).chunks;
}

function fragment(id: number, total: number, number: number, payload: Uint8Array): Uint8Array {
  return new Uint8Array([0xfe, 0xff, 0xff, 0xff, ...le(id >>> 0, 4), total, number, 0xe0, 0x04, ...payload]);
}
