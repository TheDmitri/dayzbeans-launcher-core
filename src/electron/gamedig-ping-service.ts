/**
 * GameDig Query Service for DayZ Server Ping
 * Uses the GameDig library for accurate server latency measurement via A2S protocol
 * 
 * This is more reliable than ICMP ping because:
 * 1. It measures actual game server response time
 * 2. Works even if ICMP is blocked by firewalls
 * 3. Returns additional server info (players, map, etc.)
 */

import { GameDig } from 'gamedig';

export interface GameDigPingResult {
  success: boolean;
  ping: number;
  error?: string;
  serverInfo?: {
    name: string;
    map: string;
    players: number;
    maxPlayers: number;
  };
}

// Cache for query results to avoid hammering servers.
//
// The whole result is cached, not just the ping. Caching only the number meant a
// cache hit returned `{ success, ping }` with no `serverInfo`, so every caller that
// wanted the player count silently got nothing whenever the 30s window was warm —
// including pingServersGameDig, which delegates here. Degraded mode reads player
// counts straight off these results, so the omission is load-bearing now.
const pingCache = new Map<string, { result: GameDigPingResult; timestamp: number }>();
const CACHE_DURATION = 30000; // 30 seconds cache

/**
 * Generate cache key for a server
 */
function getCacheKey(ip: string, port: number): string {
  return `${ip}:${port}`;
}

/**
 * Get a cached query result if still valid
 */
function getCachedResult(ip: string, port: number): GameDigPingResult | null {
  const key = getCacheKey(ip, port);
  const cached = pingCache.get(key);

  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.result;
  }

  return null;
}

/**
 * Cache a query result
 */
function cacheResult(ip: string, port: number, result: GameDigPingResult): void {
  const key = getCacheKey(ip, port);
  pingCache.set(key, { result, timestamp: Date.now() });
}

/**
 * Ping a DayZ server using GameDig
 * This measures the actual game server response time via A2S protocol
 * 
 * @param ip Server IP address
 * @param queryPort Server query port (Steam query port, NOT game port)
 * @param timeout Timeout in milliseconds (default: 3000)
 */
export async function pingServerGameDig(
  ip: string, 
  queryPort: number, 
  timeout: number = 3000
): Promise<GameDigPingResult> {
  try {
    // Check cache first
    const cached = getCachedResult(ip, queryPort);
    if (cached !== null) {
      console.log(`[GameDig] Using cached result for ${ip}:${queryPort}: ${cached.ping}ms`);
      return cached;
    }

    const startTime = performance.now();
    
    // Query using GameDig with the query port directly
    const state = await GameDig.query({
      type: 'dayz',
      host: ip,
      port: queryPort,
      socketTimeout: timeout,
      attemptTimeout: timeout + 1000,
      maxRetries: 1,
      givenPortOnly: true, // Use the exact query port provided
    });
    
    const endTime = performance.now();
    // Use GameDig's ping if available, otherwise calculate from query time
    const ping = state.ping ?? Math.round(endTime - startTime);
    
    console.log(`[GameDig] Success for ${ip}:${queryPort}: ${ping}ms - ${state.name}`);

    const result: GameDigPingResult = {
      success: true,
      ping,
      serverInfo: {
        name: state.name,
        map: state.map,
        players: state.numplayers ?? state.players?.length ?? 0,
        maxPlayers: state.maxplayers,
      }
    };

    // Cache the whole result, so a hit still carries serverInfo.
    // Failures stay uncached on purpose: a server that comes back should be visible
    // on the next query rather than after the TTL expires.
    cacheResult(ip, queryPort, result);

    return result;
  } catch (error) {
    const errorMessage = (error as Error).message || 'Unknown error';
    console.log(`[GameDig] Failed for ${ip}:${queryPort}: ${errorMessage}`);
    
    return {
      success: false,
      ping: 999,
      error: errorMessage
    };
  }
}

/**
 * Ping multiple servers in parallel with concurrency limit
 * 
 * @param servers Array of servers to ping (must include queryPort)
 * @param concurrency Maximum concurrent pings (default: 20)
 * @param timeout Timeout per server in ms (default: 3000)
 */
export async function pingServersGameDig(
  servers: Array<{ ip: string; queryPort: number; serverId: number }>,
  concurrency: number = 20,
  timeout: number = 3000
): Promise<Map<number, GameDigPingResult>> {
  const results = new Map<number, GameDigPingResult>();
  
  // Process in batches for controlled concurrency
  for (let i = 0; i < servers.length; i += concurrency) {
    const batch = servers.slice(i, i + concurrency);
    
    const batchPromises = batch.map(async (server) => {
      const result = await pingServerGameDig(server.ip, server.queryPort, timeout);
      return { serverId: server.serverId, result };
    });
    
    const batchResults = await Promise.all(batchPromises);
    
    for (const { serverId, result } of batchResults) {
      results.set(serverId, result);
    }
  }
  
  return results;
}

/**
 * Get server information using GameDig (includes player count)
 * This bypasses ping cache to get fresh server data
 * 
 * @param ip Server IP address
 * @param queryPort Server query port (Steam query port, NOT game port)
 * @param timeout Timeout in milliseconds (default: 3000)
 */
export async function getServerInfoGameDig(
  ip: string, 
  queryPort: number, 
  timeout: number = 3000
): Promise<GameDigPingResult> {
  try {
    console.log(`[GameDig] Getting server info for ${ip}:${queryPort}`);
    
    // Query using GameDig with the query port directly
    const state = await GameDig.query({
      type: 'dayz',
      host: ip,
      port: queryPort,
      socketTimeout: timeout,
      attemptTimeout: timeout + 1000,
      maxRetries: 1,
      givenPortOnly: true, // Use the exact query port provided
    });
    
    console.log(`[GameDig] Server info retrieved for ${ip}:${queryPort}: ${state.numplayers}/${state.maxplayers} players`);
    
    return {
      success: true,
      ping: state.ping ?? 0, // Include ping but it's not the primary focus
      serverInfo: {
        name: state.name,
        map: state.map,
        players: state.numplayers ?? state.players?.length ?? 0,
        maxPlayers: state.maxplayers,
      }
    };
  } catch (error) {
    const errorMessage = (error as Error).message || 'Unknown error';
    console.log(`[GameDig] Failed to get server info for ${ip}:${queryPort}: ${errorMessage}`);
    
    return {
      success: false,
      ping: 999,
      error: errorMessage
    };
  }
}

/**
 * Clear the ping cache
 */
export function clearPingCache(): void {
  pingCache.clear();
  console.log('[GameDig] Ping cache cleared');
}
