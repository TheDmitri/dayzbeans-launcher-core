/**
 * On-disk storage for the offline server-list snapshot.
 *
 * <h2>Why a dedicated file</h2>
 * The snapshot is ~540 KB of JSON. The two obvious homes were both wrong:
 *
 * - `localStorage` stores UTF-16, so 540 KB costs ~1.1 MB of a 5 MB quota already
 *   shared with the mod caches, and `setItem` is synchronous -- a write on every
 *   refresh would jank the renderer. A QuotaExceededError there would also take out
 *   unrelated writes like the persisted filter state.
 * - The shared electron-store `config.json` is rewritten in full on every `set()`, so
 *   parking half a megabyte in it would turn every unrelated settings write into a
 *   540 KB+ disk write, and each of the five `new Store()` instances would hold its
 *   own copy in memory.
 *
 * A plain file in userData is async, atomic, unquota'd, and costs one read at startup.
 *
 * <h2>Shape</h2>
 * The envelope's `payload` is opaque JSON *text*, not a parsed object. Validating 2000
 * nested rows on every write would burn main-process CPU for no security gain -- the
 * bytes came from our own HTTPS backend and are handed straight back to the renderer,
 * which has to walk them anyway. It also avoids a structured clone of a 2000-object
 * graph across the IPC boundary; cloning a string is a memcpy. The bound that actually
 * matters is the size cap, which is what stops a compromised renderer filling the disk.
 */

export interface SnapshotEnvelope {
  formatVersion: number;
  /** When the launcher fetched it (epoch ms). */
  fetchedAt: number;
  /** When the backend generated it (ISO-8601), for showing the data's real age. */
  generatedAt: string;
  /** Server ETag, replayed as If-None-Match on the next fetch. */
  etag: string | null;
  limit: number;
  /** Opaque snapshot JSON, exactly as received. */
  payload: string;
}

export interface SnapshotStat {
  exists: boolean;
  bytes: number;
  fetchedAt: number | null;
  generatedAt: string | null;
}

/**
 * The slice of `fs/promises` this module needs, so the logic can be tested against a
 * fake instead of requiring a main-process test harness (the project has none).
 */
export interface SnapshotFs {
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<boolean | void>;
  stat(path: string): Promise<{ size: number }>;
}

export const SNAPSHOT_FILENAME = 'server-snapshot.json';

/**
 * Write the snapshot atomically.
 *
 * Temp file plus rename, because a partial write is worse than no snapshot at all: the
 * launcher reads this during startup, and a truncated file would fail to parse on every
 * boot until something replaced it.
 */
export async function writeSnapshot(
  fs: SnapshotFs,
  filePath: string,
  envelope: SnapshotEnvelope
): Promise<{ success: boolean; bytes: number; error?: string }> {
  const tempPath = `${filePath}.tmp`;
  try {
    const serialised = JSON.stringify(envelope);
    await fs.writeFile(tempPath, serialised, 'utf8');
    await fs.rename(tempPath, filePath);
    return { success: true, bytes: serialised.length };
  } catch (error) {
    // Best-effort cleanup; a leftover .tmp is harmless and must not mask the real error.
    try {
      await fs.unlink(tempPath);
    } catch {
      /* ignore */
    }
    return { success: false, bytes: 0, error: (error as Error).message };
  }
}

/**
 * Read the snapshot, or null if there isn't a usable one.
 *
 * A corrupt file is deleted rather than reported. It can never become valid on its own,
 * and leaving it in place would mean re-reading and re-failing on every single startup;
 * removing it puts the launcher back in the well-understood "no snapshot yet" state.
 */
export async function readSnapshot(
  fs: SnapshotFs,
  filePath: string
): Promise<SnapshotEnvelope | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    // Missing file is the normal first-run case, not an error worth reporting.
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as SnapshotEnvelope;
    if (!isUsableEnvelope(parsed)) {
      throw new Error('envelope missing required fields');
    }
    return parsed;
  } catch {
    try {
      await fs.unlink(filePath);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export async function clearSnapshot(
  fs: SnapshotFs,
  filePath: string
): Promise<{ success: boolean }> {
  try {
    await fs.unlink(filePath);
    return { success: true };
  } catch {
    // Already absent is the desired end state.
    return { success: true };
  }
}

/**
 * Size and age without reading the body, so the settings cache page can show the
 * snapshot's footprint without pulling half a megabyte through the IPC bridge.
 */
export async function statSnapshot(
  fs: SnapshotFs,
  filePath: string
): Promise<SnapshotStat> {
  try {
    const { size } = await fs.stat(filePath);
    const envelope = await readSnapshot(fs, filePath);
    return {
      exists: true,
      bytes: size,
      fetchedAt: envelope?.fetchedAt ?? null,
      generatedAt: envelope?.generatedAt ?? null
    };
  } catch {
    return { exists: false, bytes: 0, fetchedAt: null, generatedAt: null };
  }
}

function isUsableEnvelope(value: unknown): value is SnapshotEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const envelope = value as Partial<SnapshotEnvelope>;
  return (
    typeof envelope.formatVersion === 'number' &&
    typeof envelope.payload === 'string' &&
    envelope.payload.length > 0 &&
    typeof envelope.fetchedAt === 'number'
  );
}
