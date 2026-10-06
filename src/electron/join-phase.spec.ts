import { beginJoinPhase, isJoinActive, resetJoinPhase, runWhenNoJoinActive } from './join-phase';

describe('join-phase', () => {
  beforeEach(() => resetJoinPhase());

  it('stays active until the last overlapping join ends', () => {
    const endFirst = beginJoinPhase(); // cancelled, still unwinding
    const endSecond = beginJoinPhase(); // the retry

    endFirst();
    expect(isJoinActive()).toBeTrue();

    endSecond();
    expect(isJoinActive()).toBeFalse();
  });

  it('ignores a join releasing twice', () => {
    const endFirst = beginJoinPhase();
    beginJoinPhase();

    endFirst();
    endFirst();

    expect(isJoinActive()).toBeTrue();
  });

  it('runs a deferred task once, when the last join ends', () => {
    const task = jasmine.createSpy('task');
    const endFirst = beginJoinPhase();
    const endSecond = beginJoinPhase();

    runWhenNoJoinActive(task);
    endFirst();
    expect(task).not.toHaveBeenCalled();

    endSecond();
    expect(task).toHaveBeenCalledTimes(1);

    beginJoinPhase()();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest deferred task', () => {
    const first = jasmine.createSpy('first');
    const second = jasmine.createSpy('second');
    const end = beginJoinPhase();

    runWhenNoJoinActive(first);
    runWhenNoJoinActive(second);
    end();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('runs the task right away when no join is active', () => {
    const task = jasmine.createSpy('task');

    runWhenNoJoinActive(task);

    expect(task).toHaveBeenCalledTimes(1);
  });
});
