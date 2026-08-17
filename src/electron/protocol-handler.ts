/**
 * The `dayzbeans://` deep-link handler.
 *
 * WHY THIS FILE IS WRITTEN DEFENSIVELY
 * ====================================
 * Every other input the main process accepts arrives from our own sandboxed
 * renderer over IPC. This one does not: a registered URI scheme can be triggered
 * by any web page the user visits, by a Discord message, by anything that can get
 * a link in front of them. It is the only remotely reachable entry point in the
 * launcher, and it reaches the main process before the renderer has any say.
 *
 * So the URL is treated as hostile input all the way through:
 *
 *   - the action must be one of ALLOWED_ACTIONS; unknown actions are dropped, not
 *     forwarded "just in case" the renderer knows what to do with them
 *   - the shape of each action's parameters is checked here, so the renderer
 *     receives something already known to be well-formed
 *   - the whole URL is length-capped before anything is parsed or logged
 *
 * Before this, `action` and `params` were split off the URL and passed straight to
 * the renderer with no allowlist at all, despite the documented action list having
 * sat in this file's header the whole time.
 */
import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { logToFile } from './logger';

/** Protocol name. Also the prefix every URL handled here must start with. */
export const PROTOCOL_NAME = 'dayzbeans';

const URL_PREFIX = `${PROTOCOL_NAME}://`;

/**
 * Nothing legitimate approaches this: the longest real link is an IPv6 address
 * with a port. The cap exists so a hostile page cannot drive megabyte-long URLs
 * into the parser or the log file.
 */
const MAX_URL_LENGTH = 2048;

/**
 * Protocol URL structure:
 *   dayzbeans://action/param1/param2?query=value
 *
 * Supported actions:
 * - dayzbeans://server/connect/{ip}:{port} - Connect to a server
 * - dayzbeans://server/view/{ip}:{port}    - View server details
 * - dayzbeans://mod/subscribe/{workshopId} - Subscribe to a mod
 * - dayzbeans://mod/view/{workshopId}      - View mod details
 * - dayzbeans://article/{articleId}        - View a news article
 * - dayzbeans://event/{eventId}            - View an event
 * - dayzbeans://navigate/{route}           - Navigate to a specific route
 */
export interface ProtocolAction {
  action: string;
  params: string[];
  query: Record<string, string>;
  rawUrl: string;
}

/**
 * The allowlist, and the shape each action's parameters must have.
 *
 * `validate` is what stops a well-named action from carrying a hostile payload:
 * `dayzbeans://mod/view/<script>` is a valid-looking action with a parameter that
 * has no business reaching a renderer. Keeping the check next to the action name
 * means adding an action without deciding what its parameters may contain is not
 * possible by omission.
 */
const HOST_AND_PORT = /^[A-Za-z0-9.:_-]{1,64}$/;
const NUMERIC_ID = /^[0-9]{1,20}$/;
/**
 * One segment of a renderer route: a slug, nothing else. `navigate` keeps its
 * segments split rather than rejoined, so a nested route such as
 * `navigate/settings/general` stays supported while each segment is still checked
 * individually -- rejoining first would let one segment smuggle a separator.
 */
const ROUTE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ROUTE_SEGMENTS = 4;

const ALLOWED_ACTIONS: Record<string, { maxParams: number; validate: (params: string[]) => boolean }> = {
  // server/connect/<ip:port>, server/view/<ip:port>
  server: {
    maxParams: 2,
    validate: ([verb, target]) => ['connect', 'view'].includes(verb) && HOST_AND_PORT.test(target ?? '')
  },
  // mod/subscribe/<workshopId>, mod/view/<workshopId>
  mod: {
    maxParams: 2,
    validate: ([verb, workshopId]) => ['subscribe', 'view'].includes(verb) && NUMERIC_ID.test(workshopId ?? '')
  },
  article: { maxParams: 1, validate: ([id]) => NUMERIC_ID.test(id ?? '') },
  event: { maxParams: 1, validate: ([id]) => NUMERIC_ID.test(id ?? '') },
  navigate: {
    maxParams: MAX_ROUTE_SEGMENTS,
    validate: (segments) => segments.length > 0 && segments.every((segment) => ROUTE_SEGMENT.test(segment))
  }
};

/** Query values are forwarded verbatim, so they are bounded rather than trusted. */
const MAX_QUERY_ENTRIES = 8;
const MAX_QUERY_VALUE_LENGTH = 256;

/**
 * Parse a `dayzbeans://` URL into an action, or null if it is not one we accept.
 *
 * Returning null covers both "malformed" and "not on the allowlist" on purpose:
 * the caller's response to either is identical, and distinguishing them in a log
 * message an attacker can trigger only tells them which half they got past.
 */
export function parseProtocolUrl(url: string): ProtocolAction | null {
  try {
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) {
      logToFile('[Protocol] Rejected URL: missing or over the length limit');
      return null;
    }

    // Anchored at the start. This used to be `url.replace(PREFIX, '')`, which
    // replaces the first occurrence anywhere in the string rather than stripping a
    // prefix -- so what got parsed was not necessarily what was matched.
    if (!url.startsWith(URL_PREFIX)) {
      logToFile('[Protocol] Rejected URL: wrong scheme');
      return null;
    }

    const withoutProtocol = url.slice(URL_PREFIX.length);
    const [pathPart, queryPart] = withoutProtocol.split('?');
    const pathSegments = pathPart.split('/').filter((segment) => segment.length > 0).map(decodeSegment);

    if (pathSegments.length === 0) {
      logToFile('[Protocol] Rejected URL: no action');
      return null;
    }

    const action = pathSegments[0];
    const params = pathSegments.slice(1);

    const rule = Object.prototype.hasOwnProperty.call(ALLOWED_ACTIONS, action) ? ALLOWED_ACTIONS[action] : undefined;
    if (!rule) {
      logToFile(`[Protocol] Rejected URL: unknown action "${summarise(action)}"`);
      return null;
    }

    if (params.length > rule.maxParams || !rule.validate(params)) {
      logToFile(`[Protocol] Rejected URL: bad parameters for action "${action}"`);
      return null;
    }

    const query: Record<string, string> = {};
    if (queryPart) {
      let count = 0;
      for (const [key, value] of new URLSearchParams(queryPart)) {
        if (count >= MAX_QUERY_ENTRIES) break;
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        query[key.slice(0, 64)] = value.slice(0, MAX_QUERY_VALUE_LENGTH);
        count++;
      }
    }

    logToFile(`[Protocol] Accepted action "${action}" with ${params.length} parameter(s)`);
    return { action, params, query, rawUrl: url };
  } catch (error) {
    logToFile(`[Protocol] Error parsing URL: ${(error as Error).message}`);
    return null;
  }
}

/** Percent-decoding must not turn one segment into two, or into a traversal. */
function decodeSegment(segment: string): string {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.includes('/') || decoded.includes('\\') || decoded === '..' ? '' : decoded;
  } catch {
    return '';
  }
}

/** Truncate an attacker-supplied string before it reaches a log line. */
function summarise(value: string): string {
  return value.length > 32 ? `${value.slice(0, 32)}...` : value;
}

// Store pending protocol URL if app is not ready yet
let pendingProtocolUrl: string | null = null;
let mainWindowRef: BrowserWindow | null = null;

/**
 * Set the main window reference for sending protocol events
 */
export function setProtocolMainWindow(win: BrowserWindow | null): void {
  mainWindowRef = win;

  // If there's a pending URL and the window is now available, handle it
  if (pendingProtocolUrl && mainWindowRef) {
    const url = pendingProtocolUrl;
    pendingProtocolUrl = null;
    handleProtocolUrl(url);
  }
}

/**
 * Handle an incoming protocol URL.
 *
 * Parsing happens before the window is touched, so a URL we do not accept cannot
 * even be used to raise and focus the window -- which would otherwise be a free
 * "yank the user out of their game" primitive for any web page.
 */
export function handleProtocolUrl(url: string): void {
  const action = parseProtocolUrl(url);
  if (!action) {
    return;
  }

  // Window not ready yet: hold the parsed URL until setProtocolMainWindow arrives.
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    pendingProtocolUrl = url;
    return;
  }

  if (mainWindowRef.isMinimized()) {
    mainWindowRef.restore();
  }
  mainWindowRef.show();
  mainWindowRef.focus();

  mainWindowRef.webContents.send('protocol-action', action);
}

/**
 * Register the dayzbeans:// protocol handler.
 * Called during app initialization.
 */
export function registerProtocol(): boolean {
  try {
    if (app.isDefaultProtocolClient(PROTOCOL_NAME)) {
      return true;
    }

    // In development the executable is Electron itself, so the project root has to
    // be passed as an argument or the launched instance has nothing to run. In a
    // packaged build the executable is the app and no argument is needed.
    const isDev = process.argv.some((arg) => arg === '--serve') || !app.isPackaged;

    const success = isDev
      ? app.setAsDefaultProtocolClient(PROTOCOL_NAME, process.execPath, [path.resolve(__dirname, '..', '..')])
      : app.setAsDefaultProtocolClient(PROTOCOL_NAME);

    logToFile(`[Protocol] Registered as default client for ${PROTOCOL_NAME}://: ${success}`);
    return success;
  } catch (error) {
    logToFile(`[Protocol] Error registering: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Unregister the protocol handler
 */
export function unregisterProtocol(): boolean {
  try {
    const success = app.removeAsDefaultProtocolClient(PROTOCOL_NAME);
    logToFile(`[Protocol] Unregistered: ${success}`);
    return success;
  } catch (error) {
    logToFile(`[Protocol] Error unregistering: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Setup protocol handling for the application.
 * Handles both Windows/Linux (second-instance) and macOS (open-url).
 */
export function setupProtocolHandling(): void {
  // A second instance started by a protocol link must hand the URL to the running
  // instance rather than opening a second launcher.
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    logToFile('[Protocol] Another instance is running, quitting');
    app.quit();
    return;
  }

  app.on('second-instance', (_event, commandLine) => {
    const protocolUrl = commandLine.find((arg) => arg.startsWith(URL_PREFIX));

    if (protocolUrl) {
      handleProtocolUrl(protocolUrl);
      return;
    }

    // No URL: the user launched the app again, so surface the existing window.
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) {
        mainWindowRef.restore();
      }
      mainWindowRef.show();
      mainWindowRef.focus();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });

  // Cold start from a protocol link: the window does not exist yet, so the URL is
  // held for setProtocolMainWindow. Validated now rather than on release, so a
  // rejected URL never occupies the pending slot.
  const protocolUrl = process.argv.find((arg) => arg.startsWith(URL_PREFIX));
  if (protocolUrl && parseProtocolUrl(protocolUrl)) {
    pendingProtocolUrl = protocolUrl;
  }
}

/**
 * Get any pending protocol URL that was received before the window was ready
 */
export function getPendingProtocolUrl(): string | null {
  return pendingProtocolUrl;
}

/**
 * Clear the pending protocol URL
 */
export function clearPendingProtocolUrl(): void {
  pendingProtocolUrl = null;
}
