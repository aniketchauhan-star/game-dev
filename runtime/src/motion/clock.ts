/**
 * Cancelable, pausable timers for one game. Everything time-based in the
 * motion system (delays, sequences, sprite frames) goes through a clock, so a
 * pause, a hidden page, a scene exit or a restart can stop all of it at once —
 * no stray timer can fire after its scene is gone.
 */
export class Clock {
  private next = 1;
  private readonly timers = new Map<number, { fn: () => void; remaining: number; started: number; handle: number | null }>();
  private paused = false;
  private rate = 1;

  after(ms: number, fn: () => void): number {
    const id = this.next++;
    const t = { fn, remaining: Math.max(0, ms), started: 0, handle: null as number | null };
    this.timers.set(id, t);
    if (!this.paused) this.arm(id);
    return id;
  }

  private arm(id: number): void {
    const t = this.timers.get(id);
    if (!t) return;
    t.started = performance.now();
    t.handle = window.setTimeout(() => {
      this.timers.delete(id);
      t.fn();
    }, t.remaining / this.rate);
  }

  clear(id: number): void {
    const t = this.timers.get(id);
    if (t?.handle !== null && t?.handle !== undefined) window.clearTimeout(t.handle);
    this.timers.delete(id);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    const now = performance.now();
    for (const t of this.timers.values()) {
      if (t.handle !== null) {
        window.clearTimeout(t.handle);
        t.remaining = Math.max(0, t.remaining - (now - t.started) * this.rate);
        t.handle = null;
      }
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const id of this.timers.keys()) this.arm(id);
  }

  /** Preview speed (editor only). Running timers keep their remaining work. */
  setRate(rate: number): void {
    const r = Math.max(0.25, Math.min(4, rate));
    if (r === this.rate) return;
    const wasPaused = this.paused;
    this.pause();
    this.rate = r;
    if (!wasPaused) this.resume();
  }

  getRate(): number {
    return this.rate;
  }

  clearAll(): void {
    for (const t of this.timers.values()) if (t.handle !== null) window.clearTimeout(t.handle);
    this.timers.clear();
  }

  get pending(): number {
    return this.timers.size;
  }
}
