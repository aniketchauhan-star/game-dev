import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../../runtime/src/motion/clock.ts';

/**
 * The motion clock is the only source of time for animations: a pause, a
 * hidden page, a screen exit or a restart must stop everything at once, and no
 * timer may fire after it was cleared.
 */
describe('motion Clock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.stubGlobal('window', globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs timers in order and forgets them once fired', () => {
    const clock = new Clock();
    const seen: string[] = [];
    clock.after(300, () => seen.push('b'));
    clock.after(100, () => seen.push('a'));
    expect(clock.pending).toBe(2);
    vi.advanceTimersByTime(300);
    expect(seen).toEqual(['a', 'b']);
    expect(clock.pending).toBe(0);
  });

  it('pauses with the remaining time kept, and resumes exactly once', () => {
    const clock = new Clock();
    const fn = vi.fn();
    clock.after(1000, fn);
    vi.advanceTimersByTime(400);
    clock.pause();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    clock.resume();
    clock.resume();
    vi.advanceTimersByTime(599);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not start new timers while paused', () => {
    const clock = new Clock();
    clock.pause();
    const fn = vi.fn();
    clock.after(10, fn);
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
    clock.resume();
    vi.advanceTimersByTime(10);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancels one timer or all of them (screen exit, restart, dispose)', () => {
    const clock = new Clock();
    const a = vi.fn();
    const b = vi.fn();
    const id = clock.after(100, a);
    clock.after(200, b);
    clock.clear(id);
    vi.advanceTimersByTime(150);
    expect(a).not.toHaveBeenCalled();
    clock.clearAll();
    vi.advanceTimersByTime(1000);
    expect(b).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
  });

  it('changes preview speed without losing progress', () => {
    const clock = new Clock();
    const fn = vi.fn();
    clock.after(1000, fn);
    vi.advanceTimersByTime(500);
    clock.setRate(2);
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(clock.getRate()).toBe(2);
    clock.setRate(100);
    expect(clock.getRate()).toBe(4);
  });
});
