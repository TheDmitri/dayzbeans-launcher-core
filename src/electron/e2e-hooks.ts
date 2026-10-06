/**
 * Test seam for the `launcher-app` end-to-end tier (docs/testing/e2e-scenarios.md §6.1).
 *
 * Inert unless BOTH are true:
 *   - DZBL_E2E=1
 *   - the app is not packaged (never in a build handed to players)
 * so a shipped launcher can never be made to load code from an environment variable.
 *
 * When active it:
 *   - moves userData to DZBL_USER_DATA before anything opens electron-store
 *     (imported first in main.ts for that reason);
 *   - loads DZBL_FAKES, a CommonJS module that replaces the outside world: the
 *     steamworks.js module, Steam install/running probes, the DayZ process;
 *   - reads DZBL_TIMING (JSON) to shorten the waits that would make tests take minutes;
 *   - lets DZBL_RENDERER_URL point the window at a dev server;
 *   - is read by startup to skip OS-level side effects (protocol registration,
 *     Discord, the spotlight fetch, the update check).
 */
import { app } from 'electron';
import * as path from 'path';

export interface GameSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
}

/** What DZBL_FAKES may export. Every member is optional; absent ones stay real. */
export interface E2EFakes {
  /** Replaces require('steamworks.js'). */
  steamworks?: unknown;
  /** Must resolve to a platform-utils SteamInstallation. */
  detectSteamInstallation?: () => Promise<unknown>;
  isSteamRunning?: () => Promise<boolean>;
  /** Replaces spawning DayZ (or `steam -applaunch`); returns a ChildProcess-like object. */
  spawnGame?: (request: GameSpawnRequest) => unknown;
  isDayZRunning?: () => Promise<boolean>;
  killAllDayZProcesses?: () => Promise<void>;
}

export interface E2ETiming {
  /** Join wait before a mod download is declared stuck (default 10 min). */
  modDownloadTimeoutMs?: number;
  /** Grace before a download Steam never starts is called metadata-only (default 45 s). */
  metadataOnlyGraceMs?: number;
  /** Splash screen minimum display (default 5 s). */
  splashMs?: number;
  /** Poll interval of the startup update sweep (default 5 s). */
  sweepPollMs?: number;
}

export interface E2EHooks {
  fakes: E2EFakes;
  timing: E2ETiming;
  rendererUrl?: string;
}

function load(): E2EHooks | null {
  if (process.env['DZBL_E2E'] !== '1' || app.isPackaged) {
    return null;
  }

  const userData = process.env['DZBL_USER_DATA'];
  if (userData) {
    app.setPath('userData', userData);
  }

  const fakesPath = process.env['DZBL_FAKES'];
  const fakes: E2EFakes = fakesPath ? require(path.resolve(fakesPath)) : {};

  const timing: E2ETiming = process.env['DZBL_TIMING'] ? JSON.parse(process.env['DZBL_TIMING']) : {};

  console.warn(`[e2e] Test hooks active (userData=${userData ?? 'default'}, fakes=${fakesPath ?? 'none'})`);
  return { fakes, timing, rendererUrl: process.env['DZBL_RENDERER_URL'] };
}

/** Null in every normal run. */
export const e2eHooks: E2EHooks | null = load();
