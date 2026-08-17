/**
 * Shared main-process file logger.
 *
 * Before this module, `logToFile` was duplicated privately in main.ts and
 * ipc-handlers.ts, and everything else (steam-service, platform-utils) used bare
 * `console.log`. In a packaged Windows GUI app stdout goes nowhere, so the most
 * useful diagnostics — the exact reason steamworks failed to initialize — were
 * never written anywhere a player could send us. Everything that matters for
 * support now goes through here.
 *
 * The file lives in userData (`app-debug.log`) and is rotated at MAX_LOG_BYTES so
 * it cannot grow without bound on a machine that never reinstalls.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB, then rotate to .1
const LOG_FILE_NAME = 'app-debug.log';

let cachedLogPath: string | null = null;

/**
 * Absolute path of the current log file. Resolved lazily: `app.getPath` is safe
 * before `ready`, but keeping it lazy means importing this module can never be
 * the thing that throws during early startup.
 */
export function getLogFilePath(): string {
  if (!cachedLogPath) {
    cachedLogPath = path.join(app.getPath('userData'), LOG_FILE_NAME);
  }
  return cachedLogPath;
}

/** Path of the rotated previous log, if one exists. */
export function getPreviousLogFilePath(): string {
  return `${getLogFilePath()}.1`;
}

function rotateIfNeeded(file: string): void {
  try {
    const stat = fs.statSync(file);
    if (stat.size < MAX_LOG_BYTES) return;
    const rotated = `${file}.1`;
    try { fs.unlinkSync(rotated); } catch { /* no previous rotation */ }
    fs.renameSync(file, rotated);
  } catch {
    // File does not exist yet, or rotation failed — either way, keep logging.
  }
}

/**
 * Append a line to the log file and mirror it to stdout.
 *
 * Never throws: logging must not be able to take down a startup path. A failure
 * to write is reported once to the console and then swallowed.
 */
export function logToFile(message: string): void {
  try {
    const file = getLogFilePath();
    rotateIfNeeded(file);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
  } catch (err) {
    try { console.error('Failed to write log:', err); } catch { /* EPIPE */ }
  }
  try { console.log(message); } catch { /* EPIPE */ }
}

/**
 * Write a session banner so a support log with several runs in it can be split
 * by run without guessing from timestamps.
 */
export function logSessionStart(): void {
  logToFile('');
  logToFile('='.repeat(72));
  logToFile(`SESSION START — v${app.getVersion()} — ${process.platform}/${process.arch} — packaged=${app.isPackaged}`);
  logToFile('='.repeat(72));
}

/**
 * Read back the tail of the log, newest lines last. Used by the diagnostics
 * report so a player can copy one blob instead of finding a file.
 */
export function readLogTail(maxLines = 200): string {
  try {
    const content = fs.readFileSync(getLogFilePath(), 'utf8');
    const lines = content.split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  } catch (err) {
    return `<could not read log file: ${(err as Error).message}>`;
  }
}
