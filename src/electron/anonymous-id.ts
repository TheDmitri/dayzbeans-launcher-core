/**
 * The launcher's anonymous install identity.
 *
 * <h2>Why the main process owns it</h2>
 * This used to live in the renderer's `localStorage`, which made it neither stable
 * nor reachable:
 *
 * - Not stable: `localStorage` sits in the renderer's cache directory. A cleared
 *   cache, a portable build with a fresh userData, or anything that resets web
 *   storage minted a brand-new identity. Metrics read that as one user lost and one
 *   user gained, which is how a 12k user base can churn without anybody leaving.
 * - Not reachable: `update-service.ts` runs in the main process and cannot read the
 *   renderer's storage, so the update check — the one request every launcher makes
 *   on every start, whether or not the user opens the browse list — went out with no
 *   identity at all and counted nobody.
 *
 * Keeping it in electron-store's `config.json` under userData fixes both: it
 * survives a cache wipe, and main-process code can read it directly.
 *
 * <h2>Shape</h2>
 * 64 hex characters, matching what the backend accepts (16-64 hex) and what the
 * renderer used to produce, so an existing install's id stays valid when adopted.
 *
 * The old implementation derived the id from a browser fingerprint. That is dropped:
 * a fingerprint made the id *less* stable, not more — a monitor change or a system
 * font update reshuffled it — while adding the one thing an anonymous id must not
 * have, which is a link back to the machine. `randomBytes` is anonymous by
 * construction and never changes once written.
 */
import { randomBytes } from 'crypto';
import Store from 'electron-store';

/** Key in the shared electron-store config. */
export const ANONYMOUS_ID_KEY = 'anonymousId';

/** What the backend's own validator accepts, narrowed to the length we emit. */
const ID_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Minimal slice of electron-store this module needs, so the logic is testable
 * without an Electron main process.
 */
export interface AnonymousIdStore {
  get(key: string): unknown;
  set(key: string, value: string): void;
}

let defaultStore: AnonymousIdStore | null = null;
let cached: string | null = null;

function sharedStore(): AnonymousIdStore {
  if (!defaultStore) {
    defaultStore = new Store() as unknown as AnonymousIdStore;
  }
  return defaultStore;
}

export function isValidAnonymousId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

/**
 * The id for this install, generated and persisted on first call.
 *
 * @param legacyId  An id found in renderer `localStorage`. Adopted only when nothing
 *                  is stored yet, so that installs predating this change keep the
 *                  identity the backend already knows them by. Without it, shipping
 *                  this would retire every existing user and acquire them again the
 *                  same day — a churn spike that never happened.
 * @param store     Injectable for tests; defaults to the shared config.
 */
export function getAnonymousId(legacyId?: string, store: AnonymousIdStore = sharedStore()): string {
  if (cached) {
    return cached;
  }

  const stored = store.get(ANONYMOUS_ID_KEY);
  if (isValidAnonymousId(stored)) {
    cached = stored.toLowerCase();
    return cached;
  }

  const adopted = isValidAnonymousId(legacyId)
    ? legacyId.toLowerCase()
    : randomBytes(32).toString('hex');

  store.set(ANONYMOUS_ID_KEY, adopted);
  cached = adopted;
  return adopted;
}

/**
 * The stored id, or null when none exists yet. Never generates or writes one.
 *
 * <p>For main-process callers that run before the renderer has had its say. The
 * startup update check fires ~4s after the window opens, while Angular only boots
 * after the 5-6s splash — so if it called {@link getAnonymousId} it would mint and
 * persist a random id first, and the renderer's legacy id would then be ignored.
 * Every existing install would be retired and re-acquired on the upgrade launch.
 * Only the renderer's IPC call creates or adopts the id; everything else peeks.
 */
export function peekAnonymousId(store: AnonymousIdStore = sharedStore()): string | null {
  if (cached) {
    return cached;
  }

  const stored = store.get(ANONYMOUS_ID_KEY);
  if (isValidAnonymousId(stored)) {
    cached = stored.toLowerCase();
    return cached;
  }
  return null;
}

/** Drops the in-memory copy. Tests only; the stored value is the source of truth. */
export function resetAnonymousIdCache(): void {
  cached = null;
  defaultStore = null;
}
