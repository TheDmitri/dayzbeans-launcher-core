/**
 * Steam diagnostics.
 *
 * When the "Steam not detected" modal appears it is a dead end: the player sees a
 * generic message, we see nothing at all, and the underlying cause (unwritable
 * working directory, quarantined native module, launcher elevated while Steam is
 * not, Steam installed somewhere the registry no longer points at) is invisible to
 * both sides. This module answers "why" in two forms:
 *
 *   - a reason CODE plus the concrete next step, shown in the modal
 *   - a full text report the player can copy into a support thread
 *
 * The report is written for a stranger to paste in public, so it is redacted:
 * home directory and username are replaced before anything leaves this module.
 */

import { app } from 'electron';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  isWindows,
  detectSteamInstallation,
  readWindowsSteamRegistry,
  isSteamRunning,
  SteamInstallation,
} from './platform-utils';
import {
  isSteamInitialized,
  getLastSteamInitFailure,
  getSteamAppIdFileNote,
  SteamInitFailure,
} from './steam-service';
import { getLogFilePath, readLogTail } from './logger';

const execAsync = promisify(exec);

export type SteamReasonCode =
  | 'ready'
  | 'disabled'
  | 'native-module-blocked'
  | 'elevation-mismatch'
  | 'steam-not-installed'
  | 'steam-not-running'
  | 'steam-api-unreachable'
  | 'unknown';

export interface SteamDiagnostics {
  generatedAt: string;
  /** Machine-readable cause; the renderer maps this to a localized explanation. */
  reason: SteamReasonCode;
  /** Untranslated one-liner. Always present, even if the UI has no string for the code. */
  headline: string;
  /** Raw error text from steamworks, when there is one. Shown verbatim. */
  rawError: string | null;
  app: {
    version: string;
    packaged: boolean;
    platform: string;
    arch: string;
    osRelease: string;
    locale: string;
  };
  process: {
    cwd: string;
    cwdWritable: boolean;
    execPath: string;
    elevated: boolean | null;
    launchedFromProtocol: boolean;
  };
  steam: {
    initialized: boolean;
    lastFailure: SteamInitFailure | null;
    appIdFile: { path: string; written: boolean; error: string | null } | null;
    installation: SteamInstallation | null;
    running: boolean;
    windowsRegistry: { installPath: string | null; installPathSource: string | null; activePid: number | null } | null;
  };
  logFile: string;
}

/**
 * Strip anything that identifies the machine's owner. Applied to the whole report
 * rather than field by field, because paths turn up inside error messages too.
 */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  const home = os.homedir();
  if (home) {
    out = out.split(home).join('<HOME>');
    // Windows paths arrive with either slash direction depending on the source.
    out = out.split(home.replace(/\\/g, '/')).join('<HOME>');
  }
  const user = os.userInfo().username;
  if (user && user.length > 2) {
    out = out.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<USER>');
  }
  return out;
}

/** Can we create a file in this directory? Answers the old cwd-write failure directly. */
function isDirWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    // W_OK on Windows does not reflect ACLs reliably, so actually try it.
    const probe = path.join(dir, `.dzbl-write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this process running elevated?
 *
 * Matters because the launcher's own error strings tell users to "run as
 * administrator" to fix mod downloads — and an elevated launcher cannot open the
 * Steam client IPC pipe when Steam runs unelevated, which locks them out of the
 * app entirely. Matched on the well-known High Mandatory Level SID rather than
 * any text, so it works on every Windows UI language.
 */
async function isElevated(): Promise<boolean | null> {
  if (isWindows) {
    try {
      const { stdout } = await execAsync('whoami /groups /fo csv /nh', { windowsHide: true, timeout: 10000 });
      return stdout.includes('S-1-16-12288');
    } catch {
      return null;
    }
  }
  if (typeof process.getuid === 'function') {
    return process.getuid() === 0;
  }
  return null;
}

/**
 * Turn the collected facts into a single cause, most specific first. Order is the
 * whole point: "Steam is not running" is true in several of these cases but is
 * the wrong thing to tell someone whose Steam is running fine.
 */
function classify(d: Omit<SteamDiagnostics, 'reason' | 'headline' | 'rawError'>): { reason: SteamReasonCode; headline: string } {
  if (d.steam.initialized) {
    return { reason: 'ready', headline: 'Steam is connected.' };
  }

  const failure = d.steam.lastFailure;

  if (failure?.stage === 'disabled') {
    return { reason: 'disabled', headline: 'Steam integration is switched off (STEAM_ENABLED=false).' };
  }

  if (failure?.stage === 'native-module') {
    return {
      reason: 'native-module-blocked',
      headline: 'The launcher\'s Steam component could not be loaded — it is missing or was blocked by antivirus.',
    };
  }

  const steamUp = d.steam.running || !!d.steam.installation?.isRunning;

  if (steamUp && d.process.elevated === true) {
    return {
      reason: 'elevation-mismatch',
      headline: 'Steam is running, but the launcher is running as administrator and cannot connect to it.',
    };
  }

  if (!d.steam.installation?.isInstalled) {
    return { reason: 'steam-not-installed', headline: 'Steam could not be found on this computer.' };
  }

  // SteamAPI_Init saying "Steam is probably not running" beats our own process
  // check, which can report a false positive (a leftover helper process, or a
  // cmdline that merely mentions Steam). Checked after the elevation case, which
  // produces the same IPC-pipe error for a completely different reason.
  const looksNotRunning = failure?.stage === 'steam-api'
    && /ipc pipe|not running|no instance/i.test(failure.message);

  if (!steamUp || looksNotRunning) {
    return { reason: 'steam-not-running', headline: 'Steam is installed but not running (or still starting up).' };
  }

  if (failure?.stage === 'steam-api') {
    return {
      reason: 'steam-api-unreachable',
      headline: 'Steam is running, but the launcher could not connect to it.',
    };
  }

  return { reason: 'unknown', headline: 'Steam could not be initialized, and the cause could not be determined.' };
}

export async function collectSteamDiagnostics(): Promise<SteamDiagnostics> {
  let installation: SteamInstallation | null = null;
  try {
    installation = await detectSteamInstallation();
  } catch { /* recorded as null; the report still ships */ }

  let running = false;
  try {
    running = await isSteamRunning();
  } catch { /* leave false */ }

  const base: Omit<SteamDiagnostics, 'reason' | 'headline' | 'rawError'> = {
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      locale: app.getLocale(),
    },
    process: {
      cwd: process.cwd(),
      cwdWritable: isDirWritable(process.cwd()),
      execPath: process.execPath,
      elevated: await isElevated(),
      launchedFromProtocol: process.argv.some(a => a.startsWith('dayzbeans://')),
    },
    steam: {
      initialized: isSteamInitialized(),
      lastFailure: getLastSteamInitFailure(),
      appIdFile: getSteamAppIdFileNote(),
      installation,
      running,
      windowsRegistry: isWindows ? await readWindowsSteamRegistry() : null,
    },
    logFile: getLogFilePath(),
  };

  const { reason, headline } = classify(base);
  return {
    ...base,
    reason,
    headline,
    rawError: base.steam.lastFailure?.message ?? null,
  };
}

/**
 * Render the diagnostics as a plain-text block for the clipboard. Deliberately
 * flat text rather than JSON: it is going to be pasted into Discord, where a wall
 * of braces is worse than a wall of lines.
 */
export function formatDiagnosticsReport(d: SteamDiagnostics, includeLogTail = true): string {
  const yn = (v: boolean | null) => (v === null ? 'unknown' : v ? 'yes' : 'no');
  const lines = [
    '=== Day(Z) Beans Launcher — Steam diagnostics ===',
    `Generated:      ${d.generatedAt}`,
    `Reason:         ${d.reason}`,
    `Summary:        ${d.headline}`,
    '',
    '--- Launcher ---',
    `Version:        ${d.app.version}${d.app.packaged ? '' : ' (unpackaged/dev)'}`,
    `Platform:       ${d.app.platform} ${d.app.arch} (${d.app.osRelease})`,
    `Locale:         ${d.app.locale}`,
    `Executable:     ${d.process.execPath}`,
    `Working dir:    ${d.process.cwd}`,
    `Wd writable:    ${yn(d.process.cwdWritable)}`,
    `Elevated:       ${yn(d.process.elevated)}`,
    `From protocol:  ${yn(d.process.launchedFromProtocol)}`,
    '',
    '--- Steam ---',
    `Initialized:    ${yn(d.steam.initialized)}`,
    `Detected as:    ${d.steam.installation?.type ?? 'unknown'}`,
    `Installed:      ${yn(d.steam.installation?.isInstalled ?? null)}`,
    `Install path:   ${d.steam.installation?.installPath ?? 'not found'}`,
    `Running:        ${yn(d.steam.running)}`,
  ];

  if (d.steam.windowsRegistry) {
    lines.push(
      `Registry path:  ${d.steam.windowsRegistry.installPath ?? 'not found'}`,
      `Registry key:   ${d.steam.windowsRegistry.installPathSource ?? 'n/a'}`,
      `Active PID:     ${d.steam.windowsRegistry.activePid ?? 'none'}`,
    );
  }

  if (d.steam.appIdFile) {
    lines.push(
      `App ID file:    ${d.steam.appIdFile.path}`,
      `App ID written: ${yn(d.steam.appIdFile.written)}${d.steam.appIdFile.error ? ` (${d.steam.appIdFile.error})` : ''}`,
    );
  }

  if (d.steam.lastFailure) {
    lines.push(
      '',
      '--- Failure ---',
      `Stage:          ${d.steam.lastFailure.stage}`,
      `Error:          ${d.steam.lastFailure.message}`,
      `Code:           ${d.steam.lastFailure.code ?? 'n/a'}`,
      `Attempts:       ${d.steam.lastFailure.attempts}`,
      `At:             ${d.steam.lastFailure.at}`,
    );
  }

  lines.push('', `Log file:       ${d.logFile}`);

  if (includeLogTail) {
    lines.push('', '--- Recent log ---', readLogTail(120));
  }

  return redact(lines.join('\n'));
}
