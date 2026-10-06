/**
 * Tells a real mod update apart from a workshop edit that changed no files.
 *
 * Staleness is partly decided by comparing the install timestamp with the workshop's
 * `timeUpdated` (see getModUpdateStatus). But `timeUpdated` also moves when an author
 * only edits the description, title or preview image. Steam, asked to download such an
 * item, has nothing to fetch: it never enters a pending or downloading state and the
 * install timestamp never moves. Every wait that required the timestamp to move then
 * ran to its deadline: a 10 minute hang and a failed join, a failed download in the
 * Mods page queue, and a re-download attempt on every launch by the startup sweep.
 *
 * Two pieces fix that:
 *
 * 1. Each download request is recorded, along with whether Steam showed any activity
 *    for the item afterwards. A request that saw no activity at all for
 *    METADATA_ONLY_GRACE_MS, with Steam's own flags clear, is a metadata-only edit.
 *    Items Steam has queued behind others report DOWNLOAD_PENDING, which counts as
 *    activity, so a busy queue does not look like a no-op.
 *
 *    A real update Steam silently dropped from its queue also shows no activity, and
 *    calling that metadata-only launches old files and acknowledges the version. So the
 *    verdict also needs a second request, made after the first had time to show activity
 *    and itself left quiet for RETRIGGER_QUIET_MS: a dropped request is re-queued by it
 *    and starts, a no-op stays a no-op. Every wait already re-asks a stalled item (the
 *    join every 10 s, the Mods page every 15 s, the sweep every other poll).
 *
 * 2. The workshop timestamp of that edit is remembered per mod, so the next timestamp
 *    comparison treats it as installed instead of flagging the mod again. A later real
 *    update has a newer timestamp and is flagged as usual.
 *
 * No Electron import here: the main process hands in its store through
 * setAcknowledgementStore, which keeps this module testable in the renderer test runner.
 */

/** How long Steam gets to show any sign of a download before the edit is called metadata-only. */
export const METADATA_ONLY_GRACE_MS = 45_000;

/**
 * How long a re-request must come after the first, and then stay quiet, before the
 * verdict. Capped by the grace period so the e2e suite's short grace still applies.
 */
export const RETRIGGER_QUIET_MS = 10_000;

/**
 * A request older than this with no observation in between is forgotten rather than
 * judged: nobody was watching, so "no activity seen" says nothing.
 */
export const REQUEST_EXPIRY_MS = 10 * 60_000;

/** Key in the shared electron-store config. */
export const ACKNOWLEDGED_KEY = 'modAcknowledgedWorkshopTimestamps';

export interface AcknowledgementStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface ObservedState {
  isInstalled: boolean;
  isDownloading: boolean;
  /** Steam's NeedsUpdate bit. */
  needsUpdateFlag: boolean;
}

interface DownloadRequest {
  requestedAt: number;
  lastObservedAt: number;
  sawActivity: boolean;
  /** The first re-request at least retriggerQuietMs() after requestedAt, if any. */
  retriggeredAt?: number;
}

const requests = new Map<string, DownloadRequest>();
let metadataOnlyGraceMs = METADATA_ONLY_GRACE_MS;

/** Shortens the grace period; used by the e2e suite so a scenario does not wait 45 s. */
export function setMetadataOnlyGraceMs(ms: number): void {
  metadataOnlyGraceMs = ms;
}

function retriggerQuietMs(): number {
  return Math.min(RETRIGGER_QUIET_MS, metadataOnlyGraceMs);
}
const lastWorkshopTimestamps = new Map<string, number>();

/** In-memory fallback until the main process provides its persistent store. */
const memoryStore: AcknowledgementStore = (() => {
  const values = new Map<string, unknown>();
  return { get: key => values.get(key), set: (key, value) => { values.set(key, value); } };
})();

let defaultStore: AcknowledgementStore = memoryStore;
let acknowledged: Record<string, number> | null = null;

/** Called once by the main process with its electron-store instance. */
export function setAcknowledgementStore(store: AcknowledgementStore): void {
  defaultStore = store;
  acknowledged = null;
}

function sharedStore(): AcknowledgementStore {
  return defaultStore;
}

function acknowledgements(store: AcknowledgementStore): Record<string, number> {
  if (!acknowledged) {
    const stored = store.get(ACKNOWLEDGED_KEY);
    acknowledged = stored && typeof stored === 'object' ? { ...(stored as Record<string, number>) } : {};
  }
  return acknowledged;
}

/**
 * Record that Steam was asked to download this item. Re-triggers keep the first
 * request time, so the grace period is not restarted by every retry; the first one
 * that comes late enough is remembered as the confirming re-request.
 */
export function noteDownloadRequested(workshopId: string, now = Date.now()): void {
  const existing = requests.get(workshopId);
  if (existing && now - existing.lastObservedAt < REQUEST_EXPIRY_MS) {
    if (existing.retriggeredAt === undefined && now - existing.requestedAt >= retriggerQuietMs()) {
      existing.retriggeredAt = now;
    }
    return;
  }
  requests.set(workshopId, { requestedAt: now, lastObservedAt: now, sawActivity: false });
}

/**
 * Feed one observation of the item's state. Returns true exactly once, when a pending
 * request is judged metadata-only; the request is then forgotten.
 */
export function observeState(workshopId: string, state: ObservedState, now = Date.now()): boolean {
  const request = requests.get(workshopId);
  if (!request) return false;

  if (now - request.lastObservedAt > REQUEST_EXPIRY_MS) {
    requests.delete(workshopId);
    return false;
  }
  request.lastObservedAt = now;

  if (state.isDownloading || state.needsUpdateFlag) {
    request.sawActivity = true;
    return false;
  }
  if (request.sawActivity) {
    // A real download ran and has finished; the install timestamp says the rest.
    requests.delete(workshopId);
    return false;
  }
  if (!state.isInstalled || now - request.requestedAt < metadataOnlyGraceMs) {
    return false;
  }
  // No confirming re-request yet, or it has not had its own chance to show activity.
  if (request.retriggeredAt === undefined || now - request.retriggeredAt < retriggerQuietMs()) {
    return false;
  }

  requests.delete(workshopId);
  return true;
}

/** Remember the workshop timestamp seen for a mod, for acknowledging it later. */
export function noteWorkshopTimestamp(workshopId: string, timestamp: number): void {
  if (timestamp > 0) {
    lastWorkshopTimestamps.set(workshopId, timestamp);
  }
}

export function lastWorkshopTimestamp(workshopId: string): number {
  return lastWorkshopTimestamps.get(workshopId) ?? 0;
}

/** The newest workshop version known to need no download for this mod, or 0. */
export function acknowledgedTimestamp(workshopId: string, store: AcknowledgementStore = sharedStore()): number {
  const value = acknowledgements(store)[workshopId];
  return typeof value === 'number' && value > 0 ? value : 0;
}

/** Record that this workshop version needs no download. Only ever moves forward. */
export function acknowledgeTimestamp(
  workshopId: string,
  timestamp: number,
  store: AcknowledgementStore = sharedStore()
): void {
  if (timestamp <= 0) return;
  const all = acknowledgements(store);
  if ((all[workshopId] ?? 0) >= timestamp) return;
  all[workshopId] = timestamp;
  try {
    store.set(ACKNOWLEDGED_KEY, all);
  } catch (error) {
    // Kept in memory for this session; the worst case is one more check next launch.
    console.warn('Could not persist mod acknowledgement:', (error as Error).message);
  }
}

/** Test hook: forget all in-memory state. */
export function resetModUpdateTracker(): void {
  requests.clear();
  lastWorkshopTimestamps.clear();
  metadataOnlyGraceMs = METADATA_ONLY_GRACE_MS;
  acknowledged = null;
  defaultStore = memoryStore;
}
