import type { GameAsset, GameConfig } from '@shared/schemas/game.ts';
import { MOTION_BUDGET, type AnimationBinding, type MotionTrigger } from '@shared/schemas/motion.ts';
import { MOTION_PRESETS } from '@shared/motion/presets.ts';
import { h, s } from '../dom.ts';
import type { Clock } from './clock.ts';
import { SpriteView } from './sprite.ts';

/**
 * Runs approved AnimationBindings for one screen. It is the only motion
 * engine: the studio preview and exported games use this same code.
 *
 *  - Triggers come only from the runtime's own events; a binding is data, never code.
 *  - Scheduling is deterministic: delays and `after` chains run on the shared
 *    cancelable clock; nothing outlives the screen (dispose cancels all).
 *  - Game state never waits on decoration and decoration never changes it.
 *  - Conflicts: one animation per object and visual channel; instructional >
 *    feedback > decorative; a drag cancels motion on the dragged object.
 *  - Reduced motion follows each binding's fallback; decorative motion can be
 *    switched off; budgets cap concurrent animations and particles.
 */

export interface TriggerEvent {
  type: MotionTrigger;
  control?: string | null;
  /** Entities involved (e.g. the target and the item of a drop). */
  entities?: string[];
}

export interface MotionEnv {
  screenEl: HTMLElement;
  overlay: HTMLElement;
  toStage(clientX: number, clientY: number): { x: number; y: number };
  palette: GameConfig['theme']['palette'];
  assetUrl(id: string | null | undefined): string | null;
  sprites: Map<string, SpriteView>;
  /** Stage pixels per grid unit on a coordinate screen (for move-by in grid units). */
  gridUnit?: () => number | null;
  /** True when the learner muted the game. */
  muted(): boolean;
}

export interface DirectorOptions {
  reduced: boolean;
  /** Studio editor simulation: sounds are off unless asked, and events are reported. */
  editor: boolean;
  editorSound?: boolean;
  onEvent?: (e: { kind: 'started' | 'finished' | 'skipped' | 'cancelled'; bindingId: string; reason?: string }) => void;
}

interface Run {
  binding: AnimationBinding;
  entity: string;
  channel: string;
  priority: number;
  finished: Promise<void>;
  cancel(commit: boolean): void;
  pause(): void;
  resume(): void;
  setRate(r: number): void;
}

const PRIORITY = { instructional: 3, feedback: 2, decorative: 1 } as const;
const ENTRANCE = new Set(['fade-in', 'slide-in', 'pop-in', 'label-reveal', 'scene-fade', 'scene-slide']);

function esc(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
}

/** Small deterministic PRNG (particles must not differ between preview and export). */
function rng(seed: string): () => number {
  let x = 2166136261;
  for (const c of seed) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

export class MotionDirector {
  private readonly runs = new Set<Run>();
  /** Delayed starts waiting on the clock, with the resolver of their schedule promise. */
  private readonly pending = new Map<number, () => void>();
  private readonly sounds = new Set<HTMLAudioElement>();
  private readonly lastStart = new Map<string, number>();
  private readonly hidden = new Map<HTMLElement, string>();
  private disposed = false;
  private paused = false;
  private rate = 1;
  private bursts = 0;

  constructor(
    private readonly config: GameConfig,
    private readonly screenId: string,
    private readonly env: MotionEnv,
    private readonly clock: Clock,
    private readonly opts: DirectorOptions,
  ) {}

  private get settings() {
    return this.config.motion;
  }

  private bindings(): AnimationBinding[] {
    return this.config.motion.bindings.filter((b) => b.enabled && b.screenId === this.screenId);
  }

  entity(id: string): HTMLElement | SVGElement | null {
    if (id === 'screen') return this.env.screenEl;
    return this.env.screenEl.querySelector<HTMLElement>(`[data-entity="${esc(id)}"]`);
  }

  private stageRect(el: Element): { x: number; y: number; w: number; h: number } {
    const r = el.getBoundingClientRect();
    const a = this.env.toStage(r.left, r.top);
    const b = this.env.toStage(r.right, r.bottom);
    return { x: a.x, y: a.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y) };
  }

  /** Why a binding will not run right now (null = it runs). */
  private gate(b: AnimationBinding): string | null {
    const preset = MOTION_PRESETS[b.presetId];
    if (preset.purpose === 'decorative' && this.settings.decorativeIntensity === 'off') return 'decorative effects are off';
    if (this.opts.reduced && b.reducedMotion === 'skip') return 'reduced motion';
    if (b.presetId === 'particle-burst' && this.settings.lowEffects) return 'low-effects mode';
    return null;
  }

  private mode(b: AnimationBinding): 'full' | 'static' | 'stepwise' {
    if (!this.opts.reduced) return 'full';
    if (b.reducedMotion === 'unchanged') return 'full';
    return b.reducedMotion === 'stepwise' ? 'stepwise' : 'static';
  }

  private duration(b: AnimationBinding): number {
    const preset = MOTION_PRESETS[b.presetId];
    const calm = this.settings.pacing === 'calm' && preset.purpose !== 'feedback' ? 1.3 : 1;
    return Math.round(b.timing.durationMs * calm);
  }

  private easing(b: AnimationBinding): string {
    return b.timing.easing;
  }

  /**
   * Hide the targets of entrance animations that will run when the screen
   * opens, so they do not flash before their entrance. Call right after the
   * screen is attached (before the browser paints).
   */
  prepare(): void {
    for (const b of this.bindings()) {
      if (b.trigger.event !== 'scene-entered' || !ENTRANCE.has(b.presetId)) continue;
      if (this.gate(b) || this.mode(b) !== 'full') continue;
      const el = this.entity(b.target);
      if (!(el instanceof HTMLElement)) continue;
      // Controls and pieces the learner handles are never hidden in advance, and nothing waits hidden for long.
      if (el.matches('button, [role="button"], .nx-card, .nx-bay') || b.timing.delayMs > 3000) continue;
      if (b.presetId === 'label-reveal') {
        for (const child of Array.from(el.children) as HTMLElement[]) if (!child.matches('button')) this.hide(child);
      } else this.hide(el);
    }
  }

  private hide(el: HTMLElement): void {
    if (this.hidden.has(el)) return;
    this.hidden.set(el, el.style.getPropertyValue('opacity'));
    el.style.setProperty('opacity', '0');
  }

  private unhide(el: Element | null): void {
    if (!(el instanceof HTMLElement) || !this.hidden.has(el)) return;
    const prev = this.hidden.get(el)!;
    this.hidden.delete(el);
    if (prev) el.style.setProperty('opacity', prev);
    else el.style.removeProperty('opacity');
  }

  private revealAll(): void {
    for (const el of [...this.hidden.keys()]) this.unhide(el);
  }

  /** Does a binding react to this event? */
  private matches(b: AnimationBinding, e: TriggerEvent): boolean {
    if (b.trigger.event !== e.type) return false;
    if (b.trigger.event === 'control-activated' && b.trigger.control !== (e.control ?? null)) return false;
    if (b.trigger.entity && !(e.entities ?? []).includes(b.trigger.entity)) return false;
    return true;
  }

  /**
   * Start every binding for an event. Resolves when they have all finished
   * (or were skipped / cancelled) — used only for bounded, skippable waits.
   */
  fire(e: TriggerEvent): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const triggered = this.bindings().filter((b) => this.matches(b, e));
    if (triggered.length === 0) return Promise.resolve();
    const ids = new Set(triggered.map((b) => b.id));
    // Roots start with the trigger; others wait for the binding they follow (same trigger only).
    const roots = triggered.filter((b) => !b.after || !ids.has(b.after));
    const done: Array<Promise<void>> = [];
    const startChain = (b: AnimationBinding, depth: number) => {
      done.push(
        this.schedule(b).then(() => {
          if (depth >= MOTION_BUDGET.maxChainDepth) return;
          for (const next of triggered.filter((x) => x.after === b.id)) startChain(next, depth + 1);
        }),
      );
    };
    for (const b of roots) startChain(b, 0);
    // Wait until every chain (including ones started later) has settled.
    const settle = async (): Promise<void> => {
      let seen = 0;
      while (seen < done.length) {
        seen = done.length;
        await Promise.allSettled(done.slice());
      }
    };
    return settle();
  }

  /** Editor preview of one binding, regardless of its trigger. */
  play(bindingId: string): Promise<void> {
    const b = this.bindings().find((x) => x.id === bindingId) ?? this.config.motion.bindings.find((x) => x.id === bindingId && x.screenId === this.screenId);
    if (!b) return Promise.resolve();
    this.prepareOne(b);
    return this.schedule({ ...b, timing: { ...b.timing, delayMs: 0 } });
  }

  private prepareOne(b: AnimationBinding): void {
    if (!ENTRANCE.has(b.presetId) || this.gate(b) || this.mode(b) !== 'full') return;
    const el = this.entity(b.target);
    if (!(el instanceof HTMLElement)) return;
    if (b.presetId === 'label-reveal') for (const c of Array.from(el.children) as HTMLElement[]) this.hide(c);
    else this.hide(el);
  }

  private schedule(b: AnimationBinding): Promise<void> {
    const reason = this.gate(b);
    if (reason) {
      this.report('skipped', b.id, reason);
      if (ENTRANCE.has(b.presetId)) this.revealTarget(b);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const go = () => {
        if (this.disposed) return resolve();
        this.start(b).then(resolve, resolve);
      };
      if (b.timing.delayMs > 0) {
        const id = this.clock.after(b.timing.delayMs, () => {
          this.pending.delete(id);
          go();
        });
        // A cancelled wait still settles, so nothing waiting on it can hang.
        this.pending.set(id, resolve);
      } else go();
    });
  }

  private revealTarget(b: AnimationBinding): void {
    const el = this.entity(b.target);
    if (!el) return;
    if (b.presetId === 'label-reveal') for (const c of Array.from(el.children)) this.unhide(c);
    this.unhide(el);
  }

  private report(kind: 'started' | 'finished' | 'skipped' | 'cancelled', bindingId: string, reason?: string): void {
    this.opts.onEvent?.({ kind, bindingId, reason });
  }

  private async start(b: AnimationBinding): Promise<void> {
    const preset = MOTION_PRESETS[b.presetId];
    const el = this.entity(b.target);
    if (!el) {
      this.report('skipped', b.id, `“${b.target}” is not on screen`);
      return;
    }
    // Repeated events: restart, but never faster than every 80 ms (no rapid flashing).
    const now = performance.now();
    if (now - (this.lastStart.get(b.id) ?? -1e9) < 80) {
      this.report('skipped', b.id, 'repeated too quickly');
      return;
    }
    this.lastStart.set(b.id, now);
    const priority = PRIORITY[b.purpose];
    const channel = preset.channel === 'outline' || preset.channel === 'overlay' || preset.channel === 'none' ? `${preset.channel}:${b.id}` : preset.channel;
    for (const r of [...this.runs]) {
      if (r.binding.id === b.id) r.cancel(true);
      else if (r.entity === b.target && r.channel === channel) {
        if (priority >= r.priority) r.cancel(true);
        else {
          this.report('skipped', b.id, `a more important animation is running on ${b.target}`);
          if (ENTRANCE.has(b.presetId)) this.revealTarget(b);
          return;
        }
      }
    }
    const cap = this.settings.lowEffects ? Math.ceil(MOTION_BUDGET.concurrentAnimations / 2) : MOTION_BUDGET.concurrentAnimations;
    if (this.runs.size >= cap) {
      this.report('skipped', b.id, 'too many animations at once');
      if (ENTRANCE.has(b.presetId)) this.revealTarget(b);
      return;
    }
    const run = this.effect(b, el, channel, priority);
    if (!run) {
      if (ENTRANCE.has(b.presetId)) this.revealTarget(b);
      return;
    }
    this.runs.add(run);
    if (this.paused) run.pause();
    run.setRate(this.rate);
    this.report('started', b.id);
    this.playSound(b);
    await run.finished;
    this.runs.delete(run);
    this.report('finished', b.id);
  }

  private playSound(b: AnimationBinding): void {
    if (!b.sound || !this.settings.sound || this.env.muted() || (this.opts.editor && !this.opts.editorSound)) return;
    const url = this.env.assetUrl(b.sound.assetId);
    if (!url) return;
    try {
      const a = new Audio(url);
      a.volume = Math.max(0, Math.min(1, b.sound.volume * this.settings.soundVolume));
      this.sounds.add(a);
      a.addEventListener('ended', () => this.sounds.delete(a));
      void a.play().catch(() => this.sounds.delete(a));
    } catch {
      // Missing or blocked audio never blocks learning.
    }
  }

  // ───────────── effects ─────────────

  private waapi(b: AnimationBinding, el: Element, channel: string, priority: number, anims: Animation[], cleanup: (commit: boolean) => void, extra?: { timers?: number[] }): Run {
    let resolve!: () => void;
    const finished = new Promise<void>((r) => (resolve = r));
    let settled = false;
    const end = (commit: boolean) => {
      if (settled) return;
      settled = true;
      for (const t of extra?.timers ?? []) this.clock.clear(t);
      cleanup(commit);
      resolve();
    };
    Promise.all(anims.map((a) => a.finished))
      .then(() => end(true))
      .catch(() => end(false));
    if (anims.length === 0) end(true);
    return {
      binding: b,
      entity: b.target,
      channel,
      priority,
      finished,
      cancel: (commit) => {
        for (const a of anims) {
          try {
            if (commit) a.finish();
            else a.cancel();
          } catch {
            a.cancel();
          }
        }
        end(commit);
      },
      pause: () => anims.forEach((a) => a.pause()),
      resume: () => anims.forEach((a) => a.play()),
      setRate: (r) => anims.forEach((a) => (a.playbackRate = r)),
    };
  }

  /** A run driven only by clock timers (steady outlines, stepwise moves, clips). */
  private timed(b: AnimationBinding, channel: string, priority: number, ms: number, onEnd: (commit: boolean) => void, steps: Array<{ at: number; fn: () => void }> = []): Run {
    let resolve!: () => void;
    const finished = new Promise<void>((r) => (resolve = r));
    let settled = false;
    const ids: number[] = [];
    const end = (commit: boolean) => {
      if (settled) return;
      settled = true;
      for (const id of ids) this.clock.clear(id);
      onEnd(commit);
      resolve();
    };
    for (const st of steps) ids.push(this.clock.after(st.at, st.fn));
    ids.push(this.clock.after(ms, () => end(true)));
    return { binding: b, entity: b.target, channel, priority, finished, cancel: (commit) => end(commit), pause: () => {}, resume: () => {}, setRate: () => {} };
  }

  private color(name: string): string {
    const p = this.env.palette;
    return name === 'success' ? p.success : name === 'primary' ? p.primary : name === 'focus' ? p.focus : p.accent;
  }

  private outlineBox(el: Element, color: string, width: number, dashed = false): HTMLElement {
    const r = this.stageRect(el);
    const pad = 10;
    const box = h('div', { class: `nx-motion-outline${dashed ? ' nx-dashed' : ''}`, attrs: { 'aria-hidden': 'true' } });
    box.style.setProperty('left', `${r.x - pad}px`);
    box.style.setProperty('top', `${r.y - pad}px`);
    box.style.setProperty('width', `${r.w + pad * 2}px`);
    box.style.setProperty('height', `${r.h + pad * 2}px`);
    box.style.setProperty('border-width', `${width}px`);
    box.style.setProperty('border-color', color);
    this.env.overlay.appendChild(box);
    return box;
  }

  private effect(b: AnimationBinding, el: HTMLElement | SVGElement, channel: string, priority: number): Run | null {
    const d = this.duration(b);
    const mode = this.mode(b);
    const p = b.params;
    const easing = this.easing(b);
    const repeat = b.timing.repeat;
    const transformOpts = (extra: KeyframeAnimationOptions = {}): KeyframeAnimationOptions => ({ duration: d, easing, iterations: repeat, composite: 'add', ...extra });

    switch (b.presetId) {
      case 'scene-cut':
        return this.timed(b, channel, priority, 1, () => {});
      case 'fade-in':
      case 'scene-fade': {
        this.unhide(el);
        if (mode !== 'full') return this.timed(b, channel, priority, 1, () => {});
        const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d, easing, fill: 'backwards' });
        return this.waapi(b, el, channel, priority, [a], () => {});
      }
      case 'slide-in':
      case 'scene-slide': {
        this.unhide(el);
        if (mode !== 'full') return this.timed(b, channel, priority, 1, () => {});
        const from = String(p.from ?? 'left');
        const dist = b.presetId === 'scene-slide' ? 240 : Number(p.distance ?? 160);
        const dx = from === 'left' ? -dist : from === 'right' ? dist : 0;
        const dy = from === 'top' ? -dist : from === 'bottom' ? dist : 0;
        const a1 = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }], transformOpts({ iterations: 1, fill: 'backwards' }));
        const a2 = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d, easing, fill: 'backwards' });
        return this.waapi(b, el, channel, priority, [a1, a2], () => {});
      }
      case 'pop-in': {
        this.unhide(el);
        if (mode !== 'full') return this.timed(b, channel, priority, 1, () => {});
        const from = Number(p.from ?? 0.85);
        const a1 = el.animate([{ transform: `scale(${from})` }, { transform: 'scale(1)' }], transformOpts({ iterations: 1, fill: 'backwards' }));
        const a2 = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.round(d * 0.7), easing, fill: 'backwards' });
        return this.waapi(b, el, channel, priority, [a1, a2], () => {});
      }
      case 'label-reveal': {
        const items = (Array.from(el.children) as HTMLElement[]).filter((c) => !(c instanceof HTMLButtonElement));
        if (items.length === 0 || mode === 'static') {
          for (const c of items) this.unhide(c);
          this.unhide(el);
          if (items.length === 0 && mode === 'full') {
            const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d, easing, fill: 'backwards' });
            return this.waapi(b, el, channel, priority, [a], () => {});
          }
          return this.timed(b, channel, priority, 1, () => {});
        }
        this.unhide(el);
        const step = d / items.length;
        if (mode === 'stepwise') {
          // Discrete steps: each point simply appears, without fading.
          return this.timed(
            b,
            channel,
            priority,
            d,
            () => items.forEach((c) => this.unhide(c)),
            items.map((c, k) => ({ at: k * step, fn: () => this.unhide(c) })),
          );
        }
        const anims = items.map((c, k) => {
          this.unhide(c);
          return c.animate([{ opacity: 0, transform: 'translate(0px, 12px)' }, { opacity: 1, transform: 'translate(0px, 0px)' }], { duration: Math.max(200, step), delay: k * step, easing, fill: 'backwards', composite: 'replace' });
        });
        return this.waapi(b, el, channel, priority, anims, () => {});
      }
      case 'attention-cue': {
        if (mode !== 'full') {
          const box = this.outlineBox(el, this.color('accent'), 6);
          return this.timed(b, channel, priority, d, () => box.remove());
        }
        const a = el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], transformOpts({ iterations: 1 }));
        return this.waapi(b, el, channel, priority, [a], () => {});
      }
      case 'outline-highlight':
      case 'selected-outline':
      case 'success-highlight':
      case 'retry-cue': {
        const colorName = b.presetId === 'success-highlight' ? 'success' : String(p.color ?? (b.presetId === 'outline-highlight' ? 'accent' : 'focus'));
        const width = b.presetId === 'outline-highlight' ? Number(p.width ?? 6) : b.presetId === 'success-highlight' ? 7 : 5;
        const box = this.outlineBox(el, this.color(colorName), width, b.presetId === 'retry-cue');
        if (b.presetId === 'success-highlight') box.style.setProperty('box-shadow', `0 0 0 8px ${this.color('success')}33`);
        if (mode !== 'full') return this.timed(b, channel, priority, d * repeat, () => box.remove());
        const pulses = b.presetId === 'outline-highlight' ? Number(p.pulses ?? 2) : 1;
        const frames: Keyframe[] = [{ opacity: 0 }];
        for (let k = 0; k < pulses; k++) frames.push({ opacity: 1 }, { opacity: k === pulses - 1 ? 1 : 0.45 });
        frames.push({ opacity: 0 });
        const a = box.animate(frames, { duration: d, easing: 'ease-in-out', iterations: repeat });
        return this.waapi(b, box, channel, priority, [a], () => box.remove());
      }
      case 'path-reveal': {
        const to = this.entity(String(p.to ?? ''));
        if (!to) {
          this.report('skipped', b.id, `“${String(p.to)}” is not on screen`);
          return null;
        }
        const a = this.stageRect(el);
        const z = this.stageRect(to);
        const x1 = a.x + a.w / 2;
        const y1 = a.y + a.h / 2;
        const x2 = z.x + z.w / 2;
        const y2 = z.y + z.h / 2;
        const mx = (x1 + x2) / 2 - (y2 - y1) * 0.15;
        const my = (y1 + y2) / 2 + (x2 - x1) * 0.15;
        const col = this.color('accent');
        const path = s('path', { d: `M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}`, fill: 'none', stroke: col, 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-dasharray': p.style === 'dotted' ? '2 18' : null });
        const ang = Math.atan2(y2 - my, x2 - mx);
        const head = s('path', { d: `M${x2} ${y2} l${-26 * Math.cos(ang - 0.45)} ${-26 * Math.sin(ang - 0.45)} M${x2} ${y2} l${-26 * Math.cos(ang + 0.45)} ${-26 * Math.sin(ang + 0.45)}`, stroke: col, 'stroke-width': 8, 'stroke-linecap': 'round', fill: 'none' });
        const svg = s('svg', { class: 'nx-motion-path', viewBox: '0 0 1920 1080', width: 1920, height: 1080, 'aria-hidden': 'true' }, path, head);
        this.env.overlay.appendChild(svg);
        const hold = Number(p.hold ?? 1500);
        if (mode !== 'full' || p.style === 'dotted') {
          const anims = mode === 'full' ? [svg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d, easing })] : [];
          if (anims.length === 0) return this.timed(b, channel, priority, d + hold, () => svg.remove());
          const fade = svg.animate([{ opacity: 1 }, { opacity: 1 }, { opacity: 0 }], { duration: hold + 300, delay: d, fill: 'forwards' });
          return this.waapi(b, svg, channel, priority, [...anims, fade], () => svg.remove());
        }
        const len = (path as SVGPathElement).getTotalLength?.() || Math.hypot(x2 - x1, y2 - y1) * 1.2;
        path.setAttribute('stroke-dasharray', `${len} ${len}`);
        const draw = path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: d, easing, fill: 'forwards' });
        const showHead = head.animate([{ opacity: 0 }, { opacity: 0, offset: 0.85 }, { opacity: 1 }], { duration: d, fill: 'forwards' });
        const fade = svg.animate([{ opacity: 1 }, { opacity: 1 }, { opacity: 0 }], { duration: hold + 300, delay: d, fill: 'forwards' });
        return this.waapi(b, svg, channel, priority, [draw, showHead, fade], () => svg.remove());
      }
      case 'move-to':
      case 'move-by':
      case 'follow-path': {
        const r = this.stageRect(el);
        let pts: Array<{ x: number; y: number }>;
        if (b.presetId === 'move-to') {
          const to = typeof p.to === 'string' ? this.entity(p.to) : null;
          if (typeof p.to === 'string' && !to) {
            this.report('skipped', b.id, `“${p.to}” is not on screen`);
            return null;
          }
          const dest = to ? (() => { const z = this.stageRect(to); return { x: z.x + z.w / 2, y: z.y + z.h / 2 }; })() : { x: Number(p.x ?? 960), y: Number(p.y ?? 540) };
          pts = [{ x: dest.x - (r.x + r.w / 2), y: dest.y - (r.y + r.h / 2) }];
        } else if (b.presetId === 'move-by') {
          const unit = p.units === 'grid' ? (this.env.gridUnit?.() ?? null) : 1;
          if (unit === null) {
            this.report('skipped', b.id, 'grid units need a coordinate screen');
            return null;
          }
          // Grid y points up; screen y points down.
          pts = [{ x: Number(p.dx ?? 0) * unit, y: (p.units === 'grid' ? -1 : 1) * Number(p.dy ?? 0) * unit }];
        } else {
          let cx = 0;
          let cy = 0;
          pts = String(p.path ?? '')
            .split(' ')
            .filter(Boolean)
            .map((pair) => {
              const [dx, dy] = pair.split(',').map(Number);
              cx += dx ?? 0;
              cy += dy ?? 0;
              return { x: cx, y: cy };
            });
        }
        // Element transforms are in its own (unscaled) space; stage pixels match because the stage scale applies to both.
        const keyframes: Keyframe[] = [{ transform: 'translate(0px, 0px)' }, ...pts.map((q) => ({ transform: `translate(${q.x}px, ${q.y}px)` }))];
        const last = pts[pts.length - 1] ?? { x: 0, y: 0 };
        if (mode === 'static') {
          const a = el.animate([{ transform: `translate(${last.x}px, ${last.y}px)` }, { transform: `translate(${last.x}px, ${last.y}px)` }], { duration: 1, fill: 'forwards', composite: 'add' });
          return this.waapi(b, el, channel, priority, [a], () => {});
        }
        if (mode === 'stepwise') {
          const a = el.animate(keyframes, { duration: d, fill: 'forwards', composite: 'add', easing: `steps(${keyframes.length - 1}, end)` });
          return this.waapi(b, el, channel, priority, [a], () => {});
        }
        const a = el.animate(keyframes, { duration: d, easing, fill: 'forwards', composite: 'add' });
        return this.waapi(b, el, channel, priority, [a], () => {});
      }
      case 'press': {
        if (mode !== 'full') return this.timed(b, channel, priority, 1, () => {});
        const a = el.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.95)' }, { transform: 'scale(1)' }], transformOpts({ iterations: 1 }));
        return this.waapi(b, el, channel, priority, [a], () => {});
      }
      case 'drop-snap': {
        if (mode !== 'full') return this.timed(b, channel, priority, 1, () => {});
        const a = el.animate([{ transform: 'scale(1.06)' }, { transform: 'scale(0.99)' }, { transform: 'scale(1)' }], transformOpts({ iterations: 1 }));
        return this.waapi(b, el, channel, priority, [a], () => {});
      }
      case 'guided-return': {
        // The game performs the reset; this shows the move from where the piece was (captured now) to where it is next frame.
        const before = this.stageRect(el);
        let resolveRun!: () => void;
        const finished = new Promise<void>((r) => (resolveRun = r));
        let anim: Animation | null = null;
        let settled = false;
        const settle = () => {
          if (!settled) {
            settled = true;
            resolveRun();
          }
        };
        requestAnimationFrame(() => {
          const now = this.entity(b.target);
          if (!now || this.disposed || mode !== 'full') return settle();
          const after = this.stageRect(now);
          const dx = before.x - after.x;
          const dy = before.y - after.y;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return settle();
          anim = now.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }], { duration: d, easing, composite: 'add' });
          anim.playbackRate = this.rate;
          anim.finished.then(settle, settle);
        });
        return {
          binding: b,
          entity: b.target,
          channel,
          priority,
          finished,
          cancel: () => {
            anim?.cancel();
            settle();
          },
          pause: () => anim?.pause(),
          resume: () => anim?.play(),
          setRate: (r) => anim && (anim.playbackRate = r),
        };
      }
      case 'celebration-clip':
      case 'character-clip': {
        const clip = String(p.clip ?? (b.presetId === 'celebration-clip' ? 'celebrate' : 'wave'));
        const own = this.env.sprites.get(b.target);
        if (!b.assetId && own) {
          if (!own.clip(clip)) {
            this.report('skipped', b.id, `no clip “${clip}”`);
            return null;
          }
          let resolveRun!: () => void;
          const finished = new Promise<void>((r) => (resolveRun = r));
          own.play(clip, repeat, this.rate).then(() => resolveRun());
          return { binding: b, entity: b.target, channel, priority, finished, cancel: () => own.cancelClip(), pause: () => {}, resume: () => {}, setRate: () => {} };
        }
        const asset = b.assetId ? (this.config.assets[b.assetId] as GameAsset | undefined) : undefined;
        const url = this.env.assetUrl(b.assetId);
        if (!asset?.sprite || !url) {
          this.report('skipped', b.id, 'the clip asset is not available');
          return null;
        }
        const r = this.stageRect(el);
        const size = Math.max(120, Math.min(420, Math.max(r.w, r.h) * 1.1));
        const view = new SpriteView(asset, url, { width: size, height: size }, this.clock, mode !== 'full', 'nx-sprite nx-motion-clip');
        view.el.style.setProperty('left', `${r.x + r.w / 2 - size / 2}px`);
        view.el.style.setProperty('top', `${r.y + r.h / 2 - size / 2}px`);
        this.env.overlay.appendChild(view.el);
        let resolveRun!: () => void;
        const finished = new Promise<void>((res) => (resolveRun = res));
        view.play(clip, repeat, this.rate).then(() => {
          view.el.remove();
          view.dispose();
          resolveRun();
        });
        return {
          binding: b,
          entity: b.target,
          channel,
          priority,
          finished,
          cancel: () => {
            view.cancelClip();
            view.el.remove();
            view.dispose();
          },
          pause: () => {},
          resume: () => {},
          setRate: () => {},
        };
      }
      case 'particle-burst': {
        if (this.bursts >= MOTION_BUDGET.concurrentBursts) {
          this.report('skipped', b.id, 'particle budget reached');
          return null;
        }
        const r = this.stageRect(el);
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const intensity = this.settings.decorativeIntensity === 'low' ? 0.5 : 1;
        const count = Math.max(4, Math.min(MOTION_BUDGET.particlesPerBurst, Math.round(Number(p.count ?? 16) * intensity)));
        const spread = Number(p.spread ?? 160);
        const pal = this.env.palette;
        const colors = p.colors === 'success' ? [pal.success] : p.colors === 'accent' ? [pal.accent] : [pal.primary, pal.accent, pal.success];
        const rand = rng(`${b.id}:${this.screenId}`);
        const layer = h('div', { class: 'nx-particles', attrs: { 'aria-hidden': 'true' } });
        this.env.overlay.appendChild(layer);
        this.bursts++;
        const anims: Animation[] = [];
        for (let k = 0; k < count; k++) {
          const ang = (k / count) * Math.PI * 2 + rand() * 0.6;
          const dist = spread * (0.55 + rand() * 0.45);
          const dot = h('span', { class: 'nx-particle' });
          dot.style.setProperty('left', `${cx}px`);
          dot.style.setProperty('top', `${cy}px`);
          dot.style.setProperty('background', colors[k % colors.length]!);
          layer.appendChild(dot);
          anims.push(
            dot.animate(
              [
                { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 1 },
                { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px)) scale(1)`, opacity: 0 },
              ],
              { duration: d * (0.75 + rand() * 0.25), easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
            ),
          );
        }
        return this.waapi(b, layer, channel, priority, anims, () => {
          layer.remove();
          this.bursts--;
        });
      }
    }
    return null;
  }

  // ───────────── control ─────────────

  /** Drag input takes priority: stop motion on the object being handled. */
  yieldToInput(entity: string): void {
    for (const r of [...this.runs]) {
      if (r.entity === entity || (r.binding.purpose === 'decorative' && r.channel === 'transform')) {
        r.cancel(true);
        this.runs.delete(r);
        this.report('cancelled', r.binding.id, 'the learner is moving it');
      }
    }
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    for (const r of this.runs) r.pause();
    for (const a of this.sounds) a.pause();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const r of this.runs) r.resume();
    for (const a of this.sounds) void a.play().catch(() => {});
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.25, Math.min(4, rate));
    for (const r of this.runs) r.setRate(this.rate);
  }

  /** Stop everything (settling end states when `commit`), e.g. when the learner skips a celebration. */
  cancelAll(commit = true): void {
    for (const [id, resolve] of this.pending) {
      this.clock.clear(id);
      resolve();
    }
    this.pending.clear();
    for (const r of [...this.runs]) {
      r.cancel(commit);
      this.report('cancelled', r.binding.id);
    }
    this.runs.clear();
    for (const a of this.sounds) a.pause();
    this.sounds.clear();
    this.revealAll();
  }

  get active(): number {
    return this.runs.size + this.pending.size;
  }

  /** Safety net: nothing stays hidden once a trigger's animations have settled. */
  revealHidden(): void {
    this.revealAll();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelAll(false);
    this.disposed = true;
    this.env.overlay.querySelectorAll('.nx-motion-outline, .nx-motion-path, .nx-particles, .nx-motion-clip').forEach((n) => n.remove());
  }
}
