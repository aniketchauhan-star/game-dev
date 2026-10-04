import { icon } from '../art.ts';
import { button, fitText, h } from '../dom.ts';
import type { SceneHost } from '../types.ts';

/**
 * Common layout for interactive scenes: instruction panel, dominant
 * interaction area, separate controls, and a polite live region for feedback
 * that always pairs text with an icon (never colour alone).
 */

export type FeedbackKind = 'neutral' | 'success' | 'error' | 'hint';

export interface Frame {
  root: HTMLElement;
  area: HTMLElement;
  controls: HTMLElement;
  heading: HTMLElement;
  setFeedback(kind: FeedbackKind, text: string): void;
  showNext(onNext: () => void): void;
  nudgeHint(): void;
  setCheckEnabled(enabled: boolean): void;
  layout(): void;
}

const FEEDBACK_ICON: Record<FeedbackKind, string> = { neutral: 'info', success: 'check', error: 'x', hint: 'hint' };
const FEEDBACK_LABEL: Record<FeedbackKind, string> = { neutral: '', success: 'Correct', error: 'Not yet', hint: 'Hint' };

export function buildFrame(
  host: SceneHost,
  opts: { checkLabel: string; onCheck: () => void; onReset: () => void; onHint: () => void; extraControls?: HTMLElement[] },
): Frame {
  const { scene } = host;
  const position = scene.layout.instructionPosition;
  const heading = h('h2', { class: 'nx-scene-title', text: scene.title, attrs: { tabindex: -1 } });
  const instruction = h('p', { class: 'nx-instruction', text: scene.instruction });
  const support = scene.supportText && !host.config.settings.minimalText ? h('p', { class: 'nx-support', text: scene.supportText }) : null;
  const feedbackIcon = h('span', { class: 'nx-feedback-icon', attrs: { 'aria-hidden': 'true' } });
  const feedbackLabel = h('strong', { class: 'nx-feedback-label' });
  const feedbackText = h('span', { class: 'nx-feedback-text' });
  const feedback = h('div', { class: 'nx-feedback', attrs: { role: 'status', 'aria-live': 'polite', 'data-kind': 'neutral', hidden: true } }, feedbackIcon, feedbackLabel, feedbackText);
  const panel = h('section', { class: 'nx-instruction-panel', attrs: { 'aria-label': 'Instructions', 'data-entity': 'instruction' } }, heading, instruction, support, feedback);

  const area = h('div', { class: 'nx-area' });
  // Controls announce themselves to the motion system before acting (so effects can see the state before a change).
  const control = (name: string, fn: () => void) => () => {
    host.emit({ type: 'control-activated', control: name });
    fn();
  };
  const hintBtn = button('Hint', { class: 'nx-btn-secondary', icon: icon('hint', 30), onClick: control('hint', opts.onHint) });
  const resetBtn = button('Reset', { class: 'nx-btn-secondary', icon: icon('reset', 30), onClick: control('reset', opts.onReset) });
  const checkBtn = button(opts.checkLabel, { class: 'nx-btn-primary', icon: icon('check', 30), onClick: control('check', opts.onCheck) });
  hintBtn.setAttribute('data-entity', 'button:hint');
  resetBtn.setAttribute('data-entity', 'button:reset');
  checkBtn.setAttribute('data-entity', 'button:check');
  const actions = h('div', { class: 'nx-actions' }, hintBtn, resetBtn, checkBtn);
  const controls = h('div', { class: 'nx-controls' }, ...(opts.extraControls ?? []), actions);

  const root = h('div', { class: `nx-scene nx-pos-${position} nx-density-${scene.layout.density}`, attrs: { 'data-scene-id': scene.id, 'data-type': scene.interaction.type } }, panel, h('div', { class: 'nx-play' }, area, controls));

  return {
    root,
    area,
    controls,
    heading,
    setFeedback(kind, text) {
      feedback.hidden = text === '';
      feedback.setAttribute('data-kind', kind);
      feedbackIcon.replaceChildren(icon(FEEDBACK_ICON[kind], 34));
      feedbackLabel.textContent = FEEDBACK_LABEL[kind] ? `${FEEDBACK_LABEL[kind]}: ` : '';
      feedbackText.textContent = text;
      fitText(feedback, 20);
    },
    showNext(onNext) {
      const last = host.index === host.total - 1;
      const next = button(last ? 'Finish' : 'Next', { class: 'nx-btn-primary nx-btn-next', icon: icon('next', 30), onClick: control('next', onNext) });
      next.setAttribute('data-entity', 'button:next');
      actions.replaceChildren(next);
      next.focus();
    },
    nudgeHint() {
      hintBtn.classList.add('nx-nudge');
    },
    setCheckEnabled(enabled) {
      checkBtn.disabled = !enabled;
    },
    layout() {
      fitText(instruction, 24);
    },
  };
}

/** After how many unsuccessful checks the Hint button is nudged (guidance level from the grade profile). */
export function hintNudgeDue(host: SceneHost, attempts: number): boolean {
  const g = host.config.settings.guidance;
  return g === 'extra' ? attempts >= 1 : g === 'standard' ? attempts >= 2 : false;
}

/** Progressive hints: each request reveals the next hint; afterwards an optional “show me” action. */
export class HintLadder {
  level = 0;
  constructor(
    private readonly hints: string[],
    private readonly finalLabel: string | null,
  ) {}

  next(): { text: string; level: number; final: boolean } {
    if (this.level < this.hints.length) {
      this.level++;
      return { text: `(${this.level} of ${this.hints.length}${this.finalLabel ? '+' : ''}) ${this.hints[this.level - 1]}`, level: this.level, final: false };
    }
    this.level = this.hints.length + 1;
    return { text: this.finalLabel ?? this.hints[this.hints.length - 1] ?? '', level: this.level, final: true };
  }
}
