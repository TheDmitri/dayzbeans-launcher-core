/**
 * A join owns the Steam download queue while it runs.
 *
 * The sweep and a join both ask Steam to download things. If the sweep is pulling forty
 * mods the player does not need right now, the one mod the join is waiting for sits
 * behind them and the join times out. The join therefore claims priority, and the sweep
 * steps aside at its next batch boundary.
 *
 * Counted per join rather than one flag: a cancelled join only notices at its next poll,
 * so a retry started in between overlaps it, and the first join's release must not hand
 * the queue back while the second still needs it.
 *
 * No Electron import here, so it stays testable in the renderer test runner.
 */

let activeJoins = 0;
let whenIdle: (() => void) | null = null;

/** Claim the queue for one join. Returns its release; calling it more than once is harmless. */
export function beginJoinPhase(): () => void {
  activeJoins++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeJoins--;
    if (activeJoins === 0 && whenIdle) {
      const task = whenIdle;
      whenIdle = null;
      task();
    }
  };
}

export function isJoinActive(): boolean {
  return activeJoins > 0;
}

/**
 * Run `task` once no join holds the queue: now if none does, otherwise when the last
 * one ends. Only the latest task is kept, so a sweep that yields twice resumes once.
 */
export function runWhenNoJoinActive(task: () => void): void {
  if (activeJoins === 0) {
    task();
    return;
  }
  whenIdle = task;
}

/** Test hook. */
export function resetJoinPhase(): void {
  activeJoins = 0;
  whenIdle = null;
}
