import type { GameConfig, GameScene } from '@shared/schemas/game.ts';
import type { SceneDesign, ObjectPlacement } from '@shared/schemas/design.ts';
import { MOTION_PRESETS } from '@shared/motion/presets.ts';
import { THEME_PRESETS } from '@shared/themes.ts';
import { decorArt, icon, moverArt } from './art.ts';
import { Sound } from './audio.ts';
import { applySkin, characterArt, characterGuide, designLayer, objectsLayer, regionBoxes, type DesignCtx } from './design.ts';
import { button, clear, h, s } from './dom.ts';
import { Clock } from './motion/clock.ts';
import { MotionDirector, type TriggerEvent } from './motion/director.ts';
import type { SpriteView } from './motion/sprite.ts';
import { coordinateScene } from './scenes/coordinate.ts';
import { infoScene } from './scenes/info.ts';
import { matchScene } from './scenes/match.ts';
import { sortScene } from './scenes/sort.ts';
import type { ProgressEvent, SceneController, SceneHost } from './types.ts';

export type Reporter = (event: ProgressEvent, sceneId: string | null, detail?: { correct?: boolean; attempt?: number; hintLevel?: number }) => void;

export interface MotionReport {
  kind: 'started' | 'finished' | 'skipped' | 'cancelled';
  bindingId: string;
  reason?: string;
}

export interface GameOptions {
  /** Studio editor simulation: motion events are reported; animation sounds stay off unless asked. */
  editor?: boolean;
  onMotionEvent?: (e: MotionReport) => void;
}

const STAGE_W = 1920;
const STAGE_H = 1080;
/** Longest an exit waits for its own animations; any key or tap skips the wait. */
const EXIT_WAIT_MS = 1400;

/**
 * The learner-facing game shell: a 1920×1080 logical stage scaled to fit
 * (letterboxed, never stretched or cropped), title → scenes → completion.
 * Each screen gets its own motion director; leaving a screen cancels its
 * timers, clips, particles and sounds. Diagnostics never appear here.
 */
export class Game {
  private readonly viewport: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly hud: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly pausedLayer: HTMLElement;
  private readonly sound: Sound;
  private readonly resizeObserver: ResizeObserver;
  private readonly clock = new Clock();
  private readonly sprites = new Map<string, SpriteView>();
  private director: MotionDirector | null = null;
  private current: SceneController | null = null;
  private sceneIndex = -1;
  private screenId = 'title';
  private scale = 1;
  private paused = false;
  private hiddenPage = false;
  private leaving = false;
  private hintsUsed = 0;
  private editorSound = false;
  private completed = new Set<string>();
  readonly reducedMotion: boolean;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private visibilityHandler = () => this.onVisibility();

  constructor(
    private readonly root: HTMLElement,
    private readonly config: GameConfig,
    private readonly assets: Map<string, string>,
    private readonly report: Reporter,
    private readonly onState: (s: { paused: boolean; muted: boolean; sceneId: string | null }) => void = () => {},
    private readonly opts: GameOptions = {},
  ) {
    const p = config.theme.palette;
    this.reducedMotion = config.settings.reducedMotion || config.motion.reducedMotion === 'always' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    clear(root);
    root.classList.add('nx-root', `nx-font-${config.theme.fontStyle}`);
    root.classList.toggle('nx-reduced-motion', this.reducedMotion);
    const vars: Record<string, string> = {
      '--nx-bg': p.background,
      '--nx-bg-alt': p.backgroundAlt,
      '--nx-surface': p.surface,
      '--nx-surface-text': p.surfaceText,
      '--nx-text': p.text,
      '--nx-muted': p.mutedText,
      '--nx-primary': p.primary,
      '--nx-primary-text': p.primaryText,
      '--nx-accent': p.accent,
      '--nx-grid': p.gridLine,
      '--nx-axis': p.gridAxis,
      '--nx-success': p.success,
      '--nx-error': p.error,
      '--nx-focus': p.focus,
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);

    const bgUrl = this.assetUrl(config.theme.backgroundAssetId);
    const backdrop = bgUrl
      ? h('div', { class: 'nx-backdrop' }, h('img', { class: 'nx-bg-image', attrs: { src: bgUrl, alt: '' } }), h('div', { class: 'nx-scrim' }))
      : h('div', { class: 'nx-backdrop' }, decorArt(config.theme.decor, p));

    this.progress = h('p', { class: 'nx-progress' });
    this.muteBtn = button('', { class: 'nx-btn-icon', icon: icon('soundOn', 34), ariaLabel: 'Mute sound', onClick: () => this.setMuted(!this.sound.muted) });
    this.muteBtn.setAttribute('aria-pressed', 'false');
    this.hud = h('header', { class: 'nx-hud' }, h('p', { class: 'nx-hud-title', text: config.title }), this.progress, h('div', { class: 'nx-hud-actions' }, this.muteBtn));
    this.screen = h('div', { class: 'nx-screen' });
    this.overlay = h('div', { class: 'nx-overlay' });
    this.pausedLayer = h('div', { class: 'nx-paused', attrs: { hidden: true, role: 'dialog', 'aria-label': 'Paused' } }, h('div', { class: 'nx-paused-card' }, icon('pause', 56), h('p', { text: 'Paused' })));
    this.stage = h('div', { class: 'nx-stage' }, backdrop, this.hud, this.screen, this.overlay, this.pausedLayer);
    this.viewport = h('div', { class: 'nx-viewport' }, this.stage);
    root.appendChild(this.viewport);

    this.sound = new Sound(config.settings.audio.sfx, this.assetUrl(config.settings.audio.musicAssetId));
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.viewport);
    document.addEventListener('keydown', this.keyHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.fit();
  }

  assetUrl(id: string | null | undefined): string | null {
    if (!id) return null;
    return this.assets.get(id) ?? null;
  }

  private get designCtx(): DesignCtx {
    return { assetUrl: (id) => this.assetUrl(id), assets: this.config.assets, clock: this.clock, still: this.reducedMotion, sprites: this.sprites };
  }

  private fit(): void {
    const w = this.viewport.clientWidth || window.innerWidth;
    const hgt = this.viewport.clientHeight || window.innerHeight;
    this.scale = Math.min(w / STAGE_W, hgt / STAGE_H);
    const x = (w - STAGE_W * this.scale) / 2;
    const y = (hgt - STAGE_H * this.scale) / 2;
    this.stage.style.setProperty('transform', `translate(${x}px, ${y}px) scale(${this.scale})`);
  }

  toStage(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: (clientX - r.left) / this.scale, y: (clientY - r.top) / this.scale };
  }

  private emitState(): void {
    this.onState({ paused: this.paused, muted: this.sound.muted, sceneId: this.config.scenes[this.sceneIndex]?.id ?? null });
  }

  setMuted(muted: boolean): void {
    this.sound.setMuted(muted);
    this.muteBtn.replaceChildren(icon(muted ? 'soundOff' : 'soundOn', 34));
    this.muteBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    this.muteBtn.setAttribute('aria-pressed', String(muted));
    this.emitState();
  }

  private haltMotion(): void {
    this.clock.pause();
    this.director?.pause();
  }

  private resumeMotion(): void {
    if (this.paused || this.hiddenPage) return;
    this.clock.resume();
    this.director?.resume();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pausedLayer.hidden = false;
    this.stage.classList.add('nx-is-paused');
    this.sound.suspend();
    this.haltMotion();
    this.emitState();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pausedLayer.hidden = true;
    this.stage.classList.remove('nx-is-paused');
    this.sound.resume();
    this.resumeMotion();
    this.emitState();
  }

  /** Background activity stops while the page is hidden. */
  private onVisibility(): void {
    this.hiddenPage = document.visibilityState === 'hidden';
    if (this.hiddenPage) {
      this.haltMotion();
      this.sound.suspend();
    } else {
      if (!this.paused) this.sound.resume();
      this.resumeMotion();
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (this.paused || this.leaving) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (this.current?.onKey?.(e)) e.preventDefault();
  }

  /** Tear down the previous screen completely: controller, motion, clips, timers, overlay effects. */
  private beginScreen(): void {
    this.leaving = false;
    this.director?.dispose();
    this.director = null;
    for (const v of this.sprites.values()) v.dispose();
    this.sprites.clear();
    this.clock.clearAll();
    this.current?.destroy();
    this.current = null;
    clear(this.overlay);
  }

  private attach(el: HTMLElement, screenId: string): MotionDirector {
    this.screen.replaceChildren(el);
    this.screenId = screenId;
    const director = new MotionDirector(
      this.config,
      screenId,
      {
        screenEl: el,
        overlay: this.overlay,
        toStage: (x, y) => this.toStage(x, y),
        palette: this.config.theme.palette,
        assetUrl: (id) => this.assetUrl(id),
        sprites: this.sprites,
        gridUnit: () => {
          const v = Number(el.querySelector('[data-entity="grid"]')?.getAttribute('data-unit'));
          return Number.isFinite(v) && v > 0 ? v : null;
        },
        muted: () => this.sound.muted,
      },
      this.clock,
      { reduced: this.reducedMotion, editor: Boolean(this.opts.editor), editorSound: this.editorSound, onEvent: this.opts.onMotionEvent },
    );
    this.director = director;
    // Entrance targets are hidden before the first paint, so they do not flash.
    director.prepare();
    if (this.paused || this.hiddenPage) this.haltMotion();
    return director;
  }

  private enter(director: MotionDirector): void {
    void director.fire({ type: 'scene-entered' }).then(() => director.revealHidden());
  }

  private hasBindings(screenId: string, e: TriggerEvent): boolean {
    return this.config.motion.bindings.some(
      (b) => b.enabled && b.screenId === screenId && b.trigger.event === e.type && (b.trigger.event !== 'control-activated' || b.trigger.control === (e.control ?? null)),
    );
  }

  /**
   * Leave the screen after the animations bound to this exit (bounded, and any
   * key or tap skips). Game progress was already recorded; nothing waits on
   * decoration to decide what happens next.
   */
  private transition(e: TriggerEvent, next: () => void): void {
    if (this.leaving) return;
    const d = this.director;
    if (!d || !this.hasBindings(this.screenId, e)) {
      void d?.fire(e);
      next();
      return;
    }
    this.leaving = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', skip, true);
      document.removeEventListener('keydown', skip, true);
      this.leaving = false;
      next();
    };
    const skip = () => {
      d.cancelAll(true);
      finish();
    };
    const timer = window.setTimeout(finish, EXIT_WAIT_MS);
    document.addEventListener('pointerdown', skip, true);
    document.addEventListener('keydown', skip, true);
    void d.fire(e).then(finish);
  }

  /** Background, design layout and placed objects around a screen's content. */
  private decorate(content: HTMLElement, opts: { design: SceneDesign | null; objects: ObjectPlacement[]; background: string | null; wrapClass: string }): HTMLElement {
    const ctx = this.designCtx;
    const bgUrl = this.assetUrl(opts.background);
    const base = opts.design ? designLayer(opts.design, ctx) : bgUrl ? h('img', { class: 'nx-scene-bg', attrs: { src: bgUrl, alt: '', 'data-entity': 'background' } }) : null;
    return h('div', { class: opts.wrapClass }, base, objectsLayer(opts.objects, ctx, false), content, objectsLayer(opts.objects, ctx, true));
  }

  private hasEntranceTransition(screenId: string): boolean {
    return this.config.motion.bindings.some((b) => b.enabled && b.screenId === screenId && MOTION_PRESETS[b.presetId].category === 'transition');
  }

  showTitle(): void {
    this.beginScreen();
    this.sceneIndex = -1;
    this.hud.hidden = true;
    const { title } = this.config.screens;
    const p = this.config.theme.palette;
    const kind = THEME_PRESETS[this.config.theme.presetId as keyof typeof THEME_PRESETS]?.mover ?? 'marker';
    const art =
      characterArt(title.characterAssetId, title.characterClip, this.designCtx) ??
      s('svg', { class: 'nx-title-art', viewBox: '0 0 100 100', 'aria-hidden': 'true' }, moverArt(kind, p));
    const start = button(title.startLabel, {
      class: 'nx-btn-primary nx-btn-start',
      icon: icon('play', 36),
      onClick: () => {
        this.sound.unlock();
        this.transition({ type: 'control-activated', control: 'start' }, () => this.startScene(0));
      },
    });
    start.setAttribute('data-entity', 'button:start');
    const card = h(
      'section',
      { class: 'nx-title-card', attrs: { 'data-entity': 'title-card' } },
      art,
      h('h1', { class: 'nx-title-heading', text: title.heading, attrs: { tabindex: -1, 'data-entity': 'title-heading' } }),
      title.subheading ? h('p', { class: 'nx-title-sub', text: title.subheading }) : null,
      start,
    );
    const el = this.decorate(h('div', { class: 'nx-title-screen' }, card), { design: title.design, objects: title.objects, background: null, wrapClass: 'nx-screen-wrap' });
    const director = this.attach(el, 'title');
    start.focus();
    this.report('title-shown', null);
    this.emitState();
    this.enter(director);
  }

  startScene(index: number): void {
    const scene = this.config.scenes[index];
    if (!scene) return this.showCompletion();
    this.beginScreen();
    this.sceneIndex = index;
    this.hud.hidden = false;
    const total = this.config.scenes.length;
    if (scene.layout.showProgress) {
      this.progress.hidden = false;
      this.progress.replaceChildren(
        ...(this.config.settings.minimalText
          ? [h('span', { class: 'nx-dots', attrs: { 'aria-label': `Scene ${index + 1} of ${total}` } }, ...this.config.scenes.map((_, k) => h('span', { class: `nx-dot${k < index ? ' nx-done' : k === index ? ' nx-now' : ''}`, attrs: { 'aria-hidden': 'true' } })))]
          : [h('span', { text: `Scene ${index + 1} of ${total}` })]),
      );
    } else this.progress.hidden = true;

    const host: SceneHost = {
      config: this.config,
      scene,
      index,
      total,
      sound: this.sound,
      reducedMotion: this.reducedMotion,
      assetUrl: (id) => this.assetUrl(id),
      report: (event, detail) => {
        if (event === 'hint') this.hintsUsed++;
        this.report(event, scene.id, detail);
      },
      complete: () => {
        if (this.leaving) return;
        this.completed.add(scene.id);
        this.report('scene-completed', scene.id);
        this.transition({ type: 'scene-completed' }, () => {
          const nextIndex = scene.next ? this.config.scenes.findIndex((s2) => s2.id === scene.next) : -1;
          if (nextIndex >= 0) this.startScene(nextIndex);
          else this.showCompletion();
        });
      },
      emit: (e) => {
        if (!this.leaving) void this.director?.fire(e);
      },
      yieldToInput: (entity) => this.director?.yieldToInput(entity),
    };
    const deps = { overlay: this.overlay, toStage: (x: number, y: number) => this.toStage(x, y) };
    let controller: SceneController;
    switch (scene.interaction.type) {
      case 'info':
        controller = infoScene(host);
        break;
      case 'coordinate-navigation':
        controller = coordinateScene(host);
        break;
      case 'drag-match':
        controller = matchScene(host, deps);
        break;
      case 'sequence-sort':
        controller = sortScene(host, deps);
        break;
      default:
        controller = { el: h('p', { text: 'This scene type is not supported by this runtime.' }), mount() {}, destroy() {} };
    }
    this.dressScene(controller.el, scene);
    const enterClass = this.reducedMotion || this.hasEntranceTransition(scene.id) ? '' : ' nx-enter';
    const wrapper = this.decorate(controller.el, { design: scene.design, objects: scene.objects, background: scene.assets.background, wrapClass: `nx-scene-wrap${enterClass}` });
    const director = this.attach(wrapper, scene.id);
    this.current = controller;
    controller.mount();
    controller.el.querySelector<HTMLElement>('.nx-scene-title')?.focus({ preventScroll: true });
    this.report('scene-started', scene.id);
    this.emitState();
    this.enter(director);
  }

  /** Design regions, the scene character beside the instructions, and exact panel / button artwork. */
  private dressScene(root: HTMLElement, scene: GameScene): void {
    if (scene.design && (scene.design.regions.instruction || scene.design.regions.play)) {
      const r = regionBoxes(scene.design);
      root.classList.add('nx-regions');
      const instruction = r.instruction ?? { x: 40, y: 96, w: 1840, h: 240 };
      const play = r.play ?? { x: 40, y: instruction.y + instruction.h + 20, w: 1840, h: Math.max(320, 1050 - (instruction.y + instruction.h + 20)) };
      for (const [k, b] of [['ir', instruction], ['pr', play]] as const) {
        root.style.setProperty(`--nx-${k}-x`, `${b.x}px`);
        root.style.setProperty(`--nx-${k}-y`, `${b.y}px`);
        root.style.setProperty(`--nx-${k}-w`, `${b.w}px`);
        root.style.setProperty(`--nx-${k}-h`, `${b.h}px`);
      }
    }
    if (scene.assets.character && scene.interaction.type !== 'coordinate-navigation') {
      const panel = root.querySelector<HTMLElement>('.nx-instruction-panel, .nx-info-card');
      const guide = characterGuide(scene.assets.character, scene.assets.characterClip, this.designCtx, panel?.classList.contains('nx-info-card') ? 240 : 190);
      if (panel && guide) {
        panel.classList.add('nx-has-guide');
        panel.appendChild(guide);
      }
    }
    const panelUrl = this.assetUrl(scene.assets.panel);
    if (panelUrl) {
      const panel = root.querySelector<HTMLElement>('.nx-instruction-panel, .nx-info-card');
      if (panel) applySkin(panel, panelUrl, 'panel');
    }
    const buttonUrl = this.assetUrl(scene.assets.button);
    if (buttonUrl) applySkin(root, buttonUrl, 'buttons');
  }

  showCompletion(): void {
    this.beginScreen();
    this.sceneIndex = this.config.scenes.length;
    this.hud.hidden = true;
    const c = this.config.screens.completion;
    this.sound.complete();
    const again = button(c.replayLabel, { class: 'nx-btn-primary', icon: icon('reset', 34), onClick: () => this.transition({ type: 'control-activated', control: 'replay' }, () => this.restart()) });
    again.setAttribute('data-entity', 'button:replay');
    const summary = `${this.completed.size} of ${this.config.scenes.length} scenes completed${this.hintsUsed ? ` · ${this.hintsUsed} hint${this.hintsUsed === 1 ? '' : 's'} used` : ''}`;
    const art = characterArt(c.characterAssetId, c.characterClip, this.designCtx);
    const content = h(
      'div',
      { class: 'nx-title-screen nx-complete-screen' },
      h(
        'section',
        { class: 'nx-title-card', attrs: { 'data-entity': 'completion-card' } },
        art ?? h('span', { class: 'nx-complete-badge', attrs: { 'aria-hidden': 'true', 'data-entity': 'badge' } }, icon('check', 72)),
        h('h1', { class: 'nx-title-heading', text: c.heading, attrs: { tabindex: -1 } }),
        c.message ? h('p', { class: 'nx-title-sub', text: c.message }) : null,
        h('p', { class: 'nx-summary', text: summary }),
        again,
      ),
    );
    const el = this.decorate(content, { design: c.design, objects: c.objects, background: null, wrapClass: 'nx-screen-wrap' });
    const director = this.attach(el, 'completion');
    this.screen.querySelector<HTMLElement>('.nx-title-heading')?.focus();
    this.report('game-completed', null);
    this.emitState();
    this.enter(director);
  }

  restart(): void {
    this.completed.clear();
    this.hintsUsed = 0;
    this.report('restarted', null);
    this.showTitle();
  }

  goto(sceneId: string | null): void {
    if (!sceneId || sceneId === 'title') return this.showTitle();
    if (sceneId === 'completion') return this.showCompletion();
    const idx = this.config.scenes.findIndex((s2) => s2.id === sceneId);
    if (idx >= 0) this.startScene(idx);
  }

  // ───────────── editor simulation (studio preview only) ─────────────
  // These run the same motion code but never call the mechanics: no answers are
  // submitted, no progress is recorded, and animation sounds stay off unless asked.

  motionFire(e: TriggerEvent): void {
    void this.director?.fire(e);
  }

  motionPlay(bindingId: string): void {
    void this.director?.play(bindingId);
  }

  motionPause(): void {
    this.haltMotion();
  }

  motionResume(): void {
    this.resumeMotion();
  }

  motionRate(rate: number): void {
    this.clock.setRate(rate);
    this.director?.setRate(rate);
  }

  motionStop(): void {
    this.director?.cancelAll(true);
  }

  setEditorSound(on: boolean): void {
    this.editorSound = on;
  }

  /** Replay the current screen from its entrance (rebuilds the screen). */
  motionRestart(): void {
    if (this.sceneIndex < 0) this.showTitle();
    else if (this.sceneIndex >= this.config.scenes.length) this.showCompletion();
    else this.startScene(this.sceneIndex);
  }

  /** Where each tagged object is on the stage (for the studio's selection overlay). */
  entityRects(): Array<{ id: string; x: number; y: number; w: number; h: number }> {
    const out: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
    const seen = new Set<string>();
    for (const el of Array.from(this.screen.querySelectorAll<Element>('[data-entity]'))) {
      const id = el.getAttribute('data-entity')!;
      if (seen.has(id)) continue;
      seen.add(id);
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const a = this.toStage(r.left, r.top);
      const b = this.toStage(r.right, r.bottom);
      out.push({ id, x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) });
    }
    return out.slice(0, 200);
  }

  get currentScreenId(): string {
    return this.screenId;
  }

  destroy(): void {
    this.director?.dispose();
    this.director = null;
    for (const v of this.sprites.values()) v.dispose();
    this.sprites.clear();
    this.clock.clearAll();
    this.current?.destroy();
    this.sound.destroy();
    this.resizeObserver.disconnect();
    document.removeEventListener('keydown', this.keyHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    clear(this.root);
  }
}
