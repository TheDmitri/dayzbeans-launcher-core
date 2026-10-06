/**
 * A2S over UDP for DayZ servers: one server's info and mod list, and a LAN broadcast
 * that only reports who answered.
 *
 * gamedig stays in charge of the server list's pings. This client exists for the mod
 * list: gamedig does not expose the raw A2S_RULES bytes and its DayZ parser loses
 * entries after any mod that is not on the Workshop (see dayz-a2s-codec.ts).
 *
 * Each query uses its own socket, closed when the query settles, with a hard deadline;
 * reply sizes are capped by SplitAssembler.
 */
import * as dgram from 'dgram';
import {
  A2SInfo,
  DayZRulesPayload,
  SplitAssembler,
  classifyReply,
  decodeDayZRules,
  infoRequest,
  parseInfo,
  parseRules,
  rulesRequest,
} from './dayz-a2s-codec';

export interface DayZQueryResult {
  info: A2SInfo;
  /** Null when the server did not answer A2S_RULES or sent something unreadable. */
  rules: DayZRulesPayload | null;
  pingMs: number;
}

/**
 * Sends one request and resolves with the first complete reply, or null on timeout.
 * Datagrams from any other address or port are ignored.
 */
function exchange(socket: dgram.Socket, host: string, port: number, request: Uint8Array, timeoutMs: number): Promise<Uint8Array | null> {
  return new Promise(resolve => {
    const assembler = new SplitAssembler();
    let settled = false;
    const finish = (value: Uint8Array | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      resolve(value);
    };
    const onMessage = (message: Buffer, remote: dgram.RemoteInfo) => {
      if (remote.address !== host || remote.port !== port) return;
      try {
        const packet = assembler.push(new Uint8Array(message.buffer, message.byteOffset, message.length));
        if (packet) finish(packet);
      } catch {
        finish(null);
      }
    };
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.send(request, port, host, error => {
      if (error) finish(null);
    });
  });
}

/**
 * A2S_INFO then A2S_RULES on `host:queryPort`, answering both challenges.
 * Resolves null when the server does not answer A2S_INFO in time.
 */
export async function queryDayZServer(host: string, queryPort: number, timeoutMs = 2000): Promise<DayZQueryResult | null> {
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => { /* reported per exchange */ });
  try {
    const started = Date.now();
    let reply = classify(await exchange(socket, host, queryPort, infoRequest(), timeoutMs));
    const pingMs = Date.now() - started;
    if (reply?.kind === 'challenge') {
      reply = classify(await exchange(socket, host, queryPort, infoRequest(reply.challenge), timeoutMs));
    }
    if (reply?.kind !== 'info') return null;

    let info: A2SInfo;
    try {
      info = parseInfo(reply.body);
    } catch {
      return null;
    }

    let rules: DayZRulesPayload | null = null;
    try {
      let rulesReply = classify(await exchange(socket, host, queryPort, rulesRequest(), timeoutMs));
      if (rulesReply?.kind === 'challenge') {
        rulesReply = classify(await exchange(socket, host, queryPort, rulesRequest(rulesReply.challenge), timeoutMs));
      }
      if (rulesReply?.kind === 'rules') rules = decodeDayZRules(parseRules(rulesReply.body).chunks);
    } catch {
      // Rules off or unreadable: the info alone is still worth showing.
      rules = null;
    }
    return { info, rules, pingMs };
  } finally {
    socket.close();
  }
}

/**
 * Broadcasts one A2S_INFO request per (broadcast address, port) and collects who
 * answered within `windowMs`. Only replies `accept` approves are kept. The answers are
 * not trusted for anything: each responder is then queried directly.
 */
export function broadcastInfo(
  targets: Array<{ address: string; port: number }>,
  windowMs: number,
  accept: (address: string) => boolean,
  maxResponders = 32
): Promise<Array<{ address: string; port: number }>> {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4');
    const found = new Map<string, { address: string; port: number }>();
    const done = () => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    const timer = setTimeout(done, windowMs);
    socket.on('error', done);
    socket.on('message', (message: Buffer, remote: dgram.RemoteInfo) => {
      if (found.size >= maxResponders || !accept(remote.address)) return;
      const reply = classify(new Uint8Array(message.buffer, message.byteOffset, message.length));
      if (reply?.kind === 'info' || reply?.kind === 'challenge') {
        found.set(`${remote.address}:${remote.port}`, { address: remote.address, port: remote.port });
      }
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        done();
        return;
      }
      const request = infoRequest();
      for (const target of targets) {
        socket.send(request, target.port, target.address, () => { /* unreachable networks are fine */ });
      }
    });
  });
}

function classify(packet: Uint8Array | null) {
  return packet ? classifyReply(packet) : null;
}
