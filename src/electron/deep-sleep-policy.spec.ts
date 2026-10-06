import { shouldDeepSleep, wakeUrl, DeepSleepInputs, TRAY_IDLE_BEFORE_SLEEP_MS } from './deep-sleep-policy';

describe('deep sleep policy', () => {
  const base: DeepSleepInputs = {
    focused: false,
    hiddenToTray: false,
    awayMs: 60_000,
    gameRunningChecks: 0,
    joinActive: false,
  };

  it('sleeps once DayZ has been seen running on two checks in a row', () => {
    expect(shouldDeepSleep({ ...base, gameRunningChecks: 1 })).toBeFalse();
    expect(shouldDeepSleep({ ...base, gameRunningChecks: 2 })).toBeTrue();
  });

  it('never sleeps while the player is using the window', () => {
    expect(shouldDeepSleep({ ...base, focused: true, gameRunningChecks: 5 })).toBeFalse();
  });

  it('never sleeps during a join, which the app is waiting on', () => {
    expect(shouldDeepSleep({ ...base, gameRunningChecks: 5, joinActive: true })).toBeFalse();
  });

  it('leaves a window minimised or in the background alone when no game runs', () => {
    expect(shouldDeepSleep({ ...base, awayMs: 10 * TRAY_IDLE_BEFORE_SLEEP_MS })).toBeFalse();
  });

  it('sleeps a window left in the tray long enough', () => {
    const tray = { ...base, hiddenToTray: true };
    expect(shouldDeepSleep({ ...tray, awayMs: TRAY_IDLE_BEFORE_SLEEP_MS - 1 })).toBeFalse();
    expect(shouldDeepSleep({ ...tray, awayMs: TRAY_IDLE_BEFORE_SLEEP_MS })).toBeTrue();
  });

  it('reloads the entry page on the route the player left, flagged as a wake', () => {
    const entry = 'file:///C:/app/browser/index.html';
    expect(wakeUrl(entry, 'file:///C:/app/browser/#/servers?map=chernarus'))
      .toBe('file:///C:/app/browser/index.html?wake=1#/servers?map=chernarus');
    expect(wakeUrl(entry, 'file:///C:/app/browser/')).toBe('file:///C:/app/browser/index.html?wake=1');
    expect(wakeUrl('http://localhost:4200', 'http://localhost:4200/#/mods')).toBe('http://localhost:4200?wake=1#/mods');
    expect(wakeUrl('http://localhost:4200/?x=1', 'http://localhost:4200/?x=1#/a')).toBe('http://localhost:4200/?x=1&wake=1#/a');
  });
});
