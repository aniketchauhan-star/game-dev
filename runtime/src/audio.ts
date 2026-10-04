/**
 * Sound effects synthesized with WebAudio (no files needed) plus optional
 * background music. Nothing plays until the learner presses Start, which is
 * the user gesture browsers require.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private music: HTMLAudioElement | null = null;
  muted = false;

  constructor(
    private readonly enabled: boolean,
    private readonly musicUrl: string | null,
  ) {}

  /** Call from a click handler. */
  unlock(): void {
    if (!this.enabled && !this.musicUrl) return;
    try {
      if (!this.ctx && this.enabled) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor) this.ctx = new Ctor();
      }
      void this.ctx?.resume();
      if (this.musicUrl && !this.music) {
        this.music = new Audio(this.musicUrl);
        this.music.loop = true;
        this.music.volume = 0.25;
      }
      if (this.music && !this.muted) void this.music.play().catch(() => {});
    } catch {
      // audio unavailable — the game works silently
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.music) {
      if (muted) this.music.pause();
      else void this.music.play().catch(() => {});
    }
  }

  suspend(): void {
    void this.ctx?.suspend();
    this.music?.pause();
  }

  resume(): void {
    void this.ctx?.resume();
    if (this.music && !this.muted) void this.music.play().catch(() => {});
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.12): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + start;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  move(): void {
    this.tone(520, 0, 0.07, 'triangle', 0.05);
  }
  place(): void {
    this.tone(440, 0, 0.09, 'triangle', 0.07);
  }
  success(): void {
    this.tone(523.25, 0, 0.16);
    this.tone(659.25, 0.12, 0.16);
    this.tone(783.99, 0.24, 0.26);
  }
  error(): void {
    this.tone(220, 0, 0.22, 'sine', 0.09);
  }
  complete(): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, i * 0.13, 0.28));
  }

  destroy(): void {
    this.music?.pause();
    this.music = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
