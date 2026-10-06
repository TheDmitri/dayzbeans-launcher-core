/**
 * Deep sleep: unload the renderer while the launcher is out of sight and not needed.
 *
 * Suspending (app-suspension.ts) pauses polling, which saves CPU but frees nothing: the
 * Angular app, its store, decoded images and the V8 heap stay resident. The only way to
 * give that memory back is to let the renderer process go. So when deep-sleep-policy.ts
 * says so — typically DayZ running with the launcher behind it — the window navigates to
 * an empty page, Chromium retires the app's renderer process, and only the main process
 * (Steam, Discord presence, tray) and a tiny blank page stay. When the window comes back
 * the app reloads on the page the player left, flagged as a wake so it skips cold-start
 * work (see WAKE_QUERY).
 */

import { BrowserWindow } from 'electron';
import { isJoinActive } from './join-phase';
import { DEEP_SLEEP_CHECK_MS, shouldDeepSleep, wakeUrl } from './deep-sleep-policy';

/**
 * Same colour as the window background, so a wake shows no flash before the app paints.
 * The line of text is for a launcher left on a second screen, where it stays visible.
 */
const BLANK_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><title>DayZ Beans Launcher</title>'
  + '<body style="margin:0;height:100vh;display:grid;place-items:center;background:#1a1a2e;'
  + 'color:#8a8577;font:14px system-ui,sans-serif">Sleeping while you play. Click to wake.</body>'
);

let win: BrowserWindow | null = null;
let gameRunning: () => Promise<boolean> = async () => false;
let checkTimer: NodeJS.Timeout | null = null;
let awaySince = 0;
let gameRunningChecks = 0;
/** The URL the app was first loaded from; wake reloads it. */
let entryUrl: string | null = null;
/** The app page left behind while asleep; null while awake. */
let leftUrl: string | null = null;
/** Messages for the app held while it reloads after a wake. */
let pendingSends: Array<() => void> | null = null;

/** After did-finish-load, how long Angular takes to bootstrap and subscribe (as on a cold start). */
const APP_BOOT_MS = 2000;

export function initDeepSleep(window: BrowserWindow, isGameRunning: () => Promise<boolean>): void {
  win = window;
  gameRunning = isGameRunning;
  window.on('blur', startWatching);
  window.on('minimize', startWatching);
  window.on('hide', startWatching);
  window.on('restore', wake);
  window.on('show', wake);
  window.on('focus', wake);
  window.on('closed', () => {
    stopWatching();
    win = null;
  });
}

/** Record the URL the app is loaded from. Until then there is nothing to sleep. */
export function setAppEntryUrl(url: string): void {
  entryUrl = url;
}

/** The player is looking at and using the window. */
function inUse(w: BrowserWindow): boolean {
  return w.isFocused() && w.isVisible() && !w.isMinimized();
}

function startWatching(): void {
  if (checkTimer || leftUrl !== null) return;
  awaySince = Date.now();
  gameRunningChecks = 0;
  checkTimer = setInterval(() => void check(), DEEP_SLEEP_CHECK_MS);
}

function stopWatching(): void {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
}

async function check(): Promise<void> {
  const w = win;
  if (!w || w.isDestroyed() || inUse(w)) {
    stopWatching();
    return;
  }
  const running = await gameRunning().catch(() => false);
  gameRunningChecks = running ? gameRunningChecks + 1 : 0;
  // The player may have come back while the process check ran
  if (w.isDestroyed()) return;
  if (shouldDeepSleep({
    focused: inUse(w),
    hiddenToTray: !w.isVisible(),
    awayMs: Date.now() - awaySince,
    gameRunningChecks,
    joinActive: isJoinActive(),
  })) {
    enterDeepSleep();
  }
}

function enterDeepSleep(): void {
  const w = win;
  if (!w || w.isDestroyed() || leftUrl !== null) return;
  const url = w.webContents.getURL();
  // Only the app itself: not the splash (it hands over to the app on its own) or a page
  // that failed to load.
  if (!entryUrl || !url || url.startsWith('data:') || url.includes('loading.html')) return;
  stopWatching();
  leftUrl = url;
  console.log('💤 Deep sleep: unloading the renderer');
  void w.webContents.loadURL(BLANK_PAGE).catch(error => console.error('Deep sleep unload failed:', error));
}

/** Reload the app if it is asleep. Harmless when it is awake. */
export function wake(): void {
  stopWatching();
  const w = win;
  if (leftUrl === null || !entryUrl || !w || w.isDestroyed()) return;
  const url = wakeUrl(entryUrl, leftUrl);
  leftUrl = null;
  pendingSends = [];
  console.log('☀️ Deep sleep: reloading the app');
  const flush = () => {
    const sends = pendingSends ?? [];
    pendingSends = null;
    sends.forEach(send => send());
  };
  w.webContents.once('did-finish-load', () => setTimeout(flush, APP_BOOT_MS));
  w.webContents.loadURL(url).catch(error => {
    console.error('Deep sleep reload failed:', error);
    flush();
  });
}

/**
 * Send to the app, holding the message while a wake reload is in flight: sent straight
 * away it would reach the page being replaced, or the app before it subscribes.
 */
export function sendToApp(channel: string, ...args: unknown[]): void {
  const send = () => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  };
  if (pendingSends) pendingSends.push(send);
  else send();
}
