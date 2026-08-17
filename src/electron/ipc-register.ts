/**
 * Validated registration for every IPC channel the renderer can invoke.
 *
 * WHY THIS EXISTS
 * ===============
 * The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`,
 * `sandbox: true` in main.ts), so in the intended case the only caller of these
 * channels is our own Angular code sending well-formed payloads. That is an
 * argument for why a bad payload is unlikely, not for why the main process should
 * trust one: everything on this side of the bridge runs with full user privileges,
 * and the renderer is the half that loads remote content.
 *
 * Before this module, `types/ipc-schemas.ts` defined a full set of Zod schemas and
 * a `createValidatedHandler` wrapper that nothing ever called -- 2 of 77 handlers
 * validated anything, and the rest destructured raw `any` off the wire. A schema
 * layer wired to 3% of its surface is worse than none, because it reads like the
 * problem is handled.
 *
 * So registration goes through `handle()` here instead of `ipcMain.handle`
 * directly, and passing an argument schema is not optional -- a channel that takes
 * nothing declares `NO_ARGS`. There is no way to register a channel without
 * saying what it accepts.
 *
 * A rejected payload throws, which surfaces in the renderer as a rejected
 * `invoke()`. That is deliberate: a malformed call is a bug or an attack, and both
 * are better as a loud failure than as `undefined` flowing into a path that spawns
 * a process or writes a file.
 */
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { logToFile } from './logger';

/** Schema for a channel that takes no arguments at all. */
export const NO_ARGS = z.tuple([]);

/**
 * Zod tuples reject an argument list longer than their item list, and accept a
 * shorter one as long as the missing entries are optional -- which is exactly the
 * shape of `invoke('channel', a, b?)`. So the tuple can be written to mirror the
 * handler signature with no padding or arity juggling here.
 */
/**
 * Register an IPC handler whose arguments are validated before it runs.
 *
 * The generic is over the tuple's *items* rather than over the tuple, so that the
 * handler's parameters are inferred one-for-one from the schema: adding a schema
 * entry without adding the parameter (or vice versa) is a compile error, not a
 * runtime surprise.
 *
 * @param channel     channel name, matching the one exposed in preload.ts
 * @param argsSchema  tuple describing the arguments, or NO_ARGS
 * @param handler     receives the parsed arguments, already narrowed
 */
export function handle<TItems extends readonly z.ZodType[]>(
  channel: string,
  argsSchema: z.ZodTuple<TItems, null>,
  handler: (...args: { [K in keyof TItems]: z.infer<TItems[K]> }) => unknown
): void {
  ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const parsed = argsSchema.safeParse(args);

    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'arg'}: ${issue.message}`)
        .join('; ');

      // Logged rather than only thrown: the renderer sees the rejection, but the
      // support log is where a repeated rejection becomes visible as a pattern.
      logToFile(`IPC rejected on "${channel}": ${detail}`);
      throw new Error(`IPC validation failed for "${channel}": ${detail}`);
    }

    return handler(...(parsed.data as { [K in keyof TItems]: z.infer<TItems[K]> }));
  });
}
