/**
 * When the launcher may unload its renderer to give the memory back (see deep-sleep.ts).
 *
 * Unloading costs a reload of the Angular app when the player comes back (a second or
 * two), so it only happens where that trade is clearly worth it:
 *  - DayZ is running and the launcher has been out of focus for two checks in a row —
 *    the game wants every megabyte, and the player will not look at the launcher until
 *    they quit. Out of focus rather than minimised: most players leave the launcher open
 *    behind the game, and a launcher on a second screen reloads at the first click;
 *  - or the window has sat hidden in the tray for a long while — a launcher that lives
 *    in the tray all day should not hold a full browser in memory for it.
 * A window that is only minimised to the taskbar, with no game running, is left alone:
 * the player expects it back instantly.
 *
 * Never during a join. The renderer is waiting on the join's result to record the play
 * (track-join, last server, contest validation), so unloading it mid-join loses that.
 *
 * No Electron import here, so it stays testable in the renderer test runner.
 */

/** How often the main process re-checks while the window is out of focus. */
export const DEEP_SLEEP_CHECK_MS = 30_000;
/** Consecutive checks that must see DayZ running before the renderer is unloaded. */
export const GAME_CHECKS_BEFORE_SLEEP = 2;
/** How long a window hidden to the tray (no game) is kept loaded. */
export const TRAY_IDLE_BEFORE_SLEEP_MS = 10 * 60_000;

export interface DeepSleepInputs {
  /** The player is using the window. */
  focused: boolean;
  /** Window hidden (tray), not merely minimised to the taskbar or behind another window. */
  hiddenToTray: boolean;
  /** How long the window has been out of focus. */
  awayMs: number;
  /** Consecutive checks, up to now, that found DayZ running. */
  gameRunningChecks: number;
  joinActive: boolean;
}

export function shouldDeepSleep(s: DeepSleepInputs): boolean {
  if (s.focused || s.joinActive) return false;
  if (s.gameRunningChecks >= GAME_CHECKS_BEFORE_SLEEP) return true;
  return s.hiddenToTray && s.awayMs >= TRAY_IDLE_BEFORE_SLEEP_MS;
}

/** Query flag on the reloaded app URL, so the renderer can tell a wake from a cold start. */
export const WAKE_QUERY = 'wake=1';

/**
 * The URL to reload on wake: the app's entry page, on the route the player left, flagged
 * as a wake. Only the route (the hash) is taken from the page: the router rewrites the
 * rest of the address (file:///…/browser/index.html becomes file:///…/browser/), which
 * does not load.
 */
export function wakeUrl(entryUrl: string, leftUrl: string): string {
  const base = entryUrl.split('#')[0];
  const hashAt = leftUrl.indexOf('#');
  const hash = hashAt < 0 ? '' : leftUrl.slice(hashAt);
  if (/[?&]wake=1(&|$)/.test(base)) return base + hash;
  return `${base}${base.includes('?') ? '&' : '?'}${WAKE_QUERY}${hash}`;
}
