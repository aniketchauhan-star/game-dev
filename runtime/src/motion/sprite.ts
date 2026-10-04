import type { GameAsset, SpriteClip } from '@shared/schemas/game.ts';
import { h } from '../dom.ts';
import type { Clock } from './clock.ts';

/**
 * Draws one frame of a sprite sheet into a box and plays named clips (as set
 * up in the sprite-sheet editor). Frames come only from the uploaded sheet —
 * nothing is generated. Playback runs on the shared clock, so it pauses with
 * the game, stops with the scene, and shows a still frame with reduced motion.
 */
export class SpriteView {
  readonly el: HTMLElement;
  private readonly inner: HTMLElement;
  private frame = 0;
  private timer: number | null = null;
  private idle: SpriteClip | null = null;
  private playing: { clip: SpriteClip; frame: number; remaining: number; resolve: () => void } | null = null;
  private disposed = false;
  private scale: number;

  constructor(
    private readonly asset: GameAsset,
    url: string,
    box: { width: number; height: number },
    private readonly clock: Clock,
    private readonly still: boolean,
    className = 'nx-sprite',
  ) {
    const sp = asset.sprite!;
    this.inner = h('div', { class: 'nx-sprite-frame', attrs: { 'aria-hidden': 'true' } });
    this.el = h('div', { class: className }, this.inner);
    // Fit one frame into the box, keeping its aspect ratio (never stretched).
    const scale = Math.min(box.width / sp.frameWidth, box.height / sp.frameHeight);
    const w = sp.frameWidth * scale;
    const hgt = sp.frameHeight * scale;
    this.el.style.setProperty('width', `${box.width}px`);
    this.el.style.setProperty('height', `${box.height}px`);
    this.inner.style.setProperty('width', `${w}px`);
    this.inner.style.setProperty('height', `${hgt}px`);
    this.inner.style.setProperty('background-image', `url("${url.replace(/"/g, '%22')}")`);
    const sheetW = (sp.columns * sp.frameWidth + Math.max(0, sp.columns - 1) * sp.spacing) * scale;
    const sheetH = (sp.rows * sp.frameHeight + Math.max(0, sp.rows - 1) * sp.spacing) * scale;
    this.inner.style.setProperty('background-size', `${sheetW}px ${sheetH}px`);
    this.scale = scale;
    this.show(0);
  }

  clips(): string[] {
    return this.asset.sprite?.clips.map((c) => c.name) ?? [];
  }

  clip(name: string): SpriteClip | null {
    return this.asset.sprite?.clips.find((c) => c.name === name) ?? null;
  }

  show(frame: number): void {
    const sp = this.asset.sprite!;
    const f = Math.max(0, Math.min(sp.frameCount - 1, frame));
    this.frame = f;
    const col = f % sp.columns;
    const row = Math.floor(f / sp.columns);
    const x = col * (sp.frameWidth + sp.spacing) * this.scale;
    const y = row * (sp.frameHeight + sp.spacing) * this.scale;
    this.inner.style.setProperty('background-position', `${-x}px ${-y}px`);
  }

  /** Loop an idle clip (first frame only with reduced motion). */
  setIdle(name: string | null): void {
    this.idle = name ? this.clip(name) : null;
    if (!this.playing) this.startIdle();
  }

  private stopTimer(): void {
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
  }

  private startIdle(): void {
    this.stopTimer();
    const clip = this.idle;
    if (!clip) return;
    this.show(clip.from);
    if (this.still || !clip.loop || clip.to <= clip.from) return;
    const fps = clip.fps ?? this.asset.sprite!.fps;
    const step = () => {
      if (this.disposed || this.playing) return;
      const next = this.frame >= clip.to || this.frame < clip.from ? clip.from : this.frame + 1;
      this.show(next);
      this.timer = this.clock.after(1000 / fps, step);
    };
    this.timer = this.clock.after(1000 / fps, step);
  }

  /**
   * Play a clip `repeat` times, then return to idle (or hold the last frame).
   * With reduced motion the clip's final frame is shown for the same time.
   */
  play(name: string, repeat = 1, rate = 1): Promise<void> {
    const clip = this.clip(name);
    if (!clip || this.disposed) return Promise.resolve();
    this.cancelClip();
    this.stopTimer();
    const fps = (clip.fps ?? this.asset.sprite!.fps) * rate;
    const frames = clip.to - clip.from + 1;
    return new Promise<void>((resolve) => {
      if (this.still) {
        this.show(clip.to);
        this.playing = { clip, frame: clip.to, remaining: 0, resolve };
        this.timer = this.clock.after(Math.max(300, (frames * repeat * 1000) / fps), () => this.endClip());
        return;
      }
      this.playing = { clip, frame: clip.from, remaining: frames * repeat - 1, resolve };
      this.show(clip.from);
      const step = () => {
        const p = this.playing;
        if (!p || this.disposed) return;
        if (p.remaining <= 0) return this.endClip();
        p.remaining--;
        p.frame = p.frame >= clip.to ? clip.from : p.frame + 1;
        this.show(p.frame);
        this.timer = this.clock.after(1000 / fps, step);
      };
      this.timer = this.clock.after(1000 / fps, step);
    });
  }

  private endClip(): void {
    const p = this.playing;
    this.playing = null;
    this.stopTimer();
    if (this.idle) this.startIdle();
    p?.resolve();
  }

  /** Stop a running clip immediately (settles on the idle or final frame). */
  cancelClip(): void {
    if (!this.playing) return;
    const p = this.playing;
    this.playing = null;
    this.stopTimer();
    if (this.idle) this.startIdle();
    else this.show(p.clip.to);
    p.resolve();
  }

  /** Editor scrubbing: show the frame a clip would be on after `ms`. */
  frameAt(name: string, ms: number): void {
    const clip = this.clip(name);
    if (!clip) return;
    const fps = clip.fps ?? this.asset.sprite!.fps;
    const frames = clip.to - clip.from + 1;
    this.cancelClip();
    this.stopTimer();
    this.show(clip.from + (Math.floor((Math.max(0, ms) * fps) / 1000) % frames));
  }

  dispose(): void {
    this.disposed = true;
    this.cancelClip();
    this.stopTimer();
  }
}
