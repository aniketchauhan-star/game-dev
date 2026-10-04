import { evaluateSequence, solvedSequence } from '@shared/rules.ts';
import { sortStartOrder } from '@shared/attainability.ts';
import { formatNumber } from '@shared/coords.ts';
import type { SortInteraction } from '@shared/schemas/interaction.ts';
import { icon } from '../art.ts';
import { button, clear, h } from '../dom.ts';
import type { SceneController, SceneHost } from '../types.ts';
import { hitTest, makeDraggable, marker } from './drag.ts';
import { buildFrame, hintNudgeDue, HintLadder } from './frame.ts';
import type { MatchSceneDeps } from './match.ts';

/**
 * Sequence sorting. Reorder by dragging, or select a card and move it with the
 * arrow keys or the on-card move buttons. Equal values (duplicates) may appear
 * in either order; explicit sequences may declare interchangeable groups.
 */
export function sortScene(host: SceneHost, deps: MatchSceneDeps): SceneController {
  const i = host.scene.interaction as SortInteraction;
  const horizontal = i.orientation === 'horizontal';
  let order = sortStartOrder(i, host.config.settings.seed, host.scene.id);
  let selected: string | null = null;
  let solved = false;
  let attempts = 0;
  let positions: boolean[] | null = null;
  const hinted = new Set<string>();
  const hints = new HintLadder(host.scene.feedback.hints, 'Show me: one card has been moved into place.');
  const cleanups: Array<() => void> = [];
  const itemById = new Map(i.items.map((it) => [it.id, it]));

  const frame = buildFrame(host, { checkLabel: 'Check order', onCheck: check, onReset: reset, onHint: hint });
  const list = h('ol', { class: `nx-sort-list nx-sort-${i.orientation}`, attrs: { 'aria-label': `Cards from ${i.startLabel || 'first'} to ${i.endLabel || 'last'}` } });
  const insert = marker();
  const ends = h(
    'div',
    { class: 'nx-sort-ends', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'nx-sort-end', text: i.startLabel || 'First' }),
    h('span', { class: 'nx-sort-arrow' }, icon(horizontal ? 'right' : 'down', 30)),
    h('span', { class: 'nx-sort-end', text: i.endLabel || 'Last' }),
  );
  const board = h('div', { class: `nx-sort nx-sort-board-${i.orientation}` }, ends, list);
  frame.area.appendChild(board);

  function moveBy(id: string, delta: number): void {
    const from = order.indexOf(id);
    const to = Math.max(0, Math.min(order.length - 1, from + delta));
    if (from === to || solved) return;
    order = order.slice();
    order.splice(from, 1);
    order.splice(to, 0, id);
    positions = null;
    host.sound.move();
    render();
    list.querySelector<HTMLElement>(`[data-item="${id}"]`)?.focus();
    host.emit({ type: 'valid-drop', entities: [`card:${id}`] });
  }

  function render(): void {
    for (const c of cleanups.splice(0)) c();
    clear(list);
    order.forEach((id, idx) => {
      const it = itemById.get(id)!;
      const url = host.assetUrl(it.imageAssetId);
      const isSel = selected === id;
      const state = positions ? (positions[idx] ? 'ok' : 'bad') : null;
      const cardEl = h(
        'button',
        {
          class: `nx-card nx-sort-card${isSel ? ' nx-selected' : ''}${state ? ` nx-state-${state === 'ok' ? 'correct' : 'incorrect'}` : ''}${hinted.has(id) ? ' nx-hinted' : ''}`,
          attrs: {
            type: 'button',
            'data-item': id,
            'data-entity': `card:${id}`,
            'aria-pressed': isSel,
            'aria-label': `${it.label}${i.showValues && it.value !== null ? `, value ${it.value}` : ''}, position ${idx + 1} of ${order.length}${state === 'ok' ? ', in the right place' : state === 'bad' ? ', not in the right place yet' : ''}. ${isSel ? `Selected — use the arrow keys to move it ${horizontal ? 'left or right' : 'up or down'}, Enter to drop.` : 'Select to move.'}`,
          },
        },
        h('span', { class: 'nx-sort-pos', text: String(idx + 1), attrs: { 'aria-hidden': 'true' } }),
        url ? h('img', { class: 'nx-card-img', attrs: { src: url, alt: '', draggable: 'false' } }) : null,
        h('span', { class: 'nx-card-label', text: it.label }),
        i.showValues && it.value !== null ? h('span', { class: 'nx-card-value', text: formatNumber(it.value) }) : null,
        state === 'ok' ? h('span', { class: 'nx-card-mark nx-mark-ok' }, icon('check', 26)) : null,
        state === 'bad' ? h('span', { class: 'nx-card-mark nx-mark-bad' }, icon('x', 26)) : null,
      );
      cleanups.push(
        makeDraggable(cardEl, {
          overlay: deps.overlay,
          toStage: deps.toStage,
          onStart: () => {
            selected = null;
            board.classList.add('nx-drag-active');
            host.yieldToInput(`card:${id}`);
            host.emit({ type: 'object-selected', entities: [`card:${id}`] });
          },
          onMove: (x, y) => {
            const target = hitTest(x, y, '.nx-sort-item');
            if (target) {
              const r = target.getBoundingClientRect();
              const after = horizontal ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
              target.parentElement?.insertBefore(insert, after ? target.nextSibling : target);
            }
          },
          onDrop: (x, y) => {
            board.classList.remove('nx-drag-active');
            const target = hitTest(x, y, '.nx-sort-item');
            insert.remove();
            if (!target) return render();
            const targetId = target.getAttribute('data-item-id')!;
            const r = target.getBoundingClientRect();
            const after = horizontal ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
            const without = order.filter((o) => o !== id);
            let at = without.indexOf(targetId);
            if (at < 0) at = without.length;
            if (after) at += 1;
            without.splice(at, 0, id);
            order = without;
            positions = null;
            host.sound.place();
            render();
            host.emit({ type: 'valid-drop', entities: [`card:${id}`] });
          },
          onTap: () => {
            if (solved) return;
            selected = selected === id ? null : id;
            render();
            list.querySelector<HTMLElement>(`[data-item="${id}"]`)?.focus();
            if (selected) host.emit({ type: 'object-selected', entities: [`card:${id}`] });
          },
        }),
      );
      const moves = isSel
        ? h(
            'div',
            { class: 'nx-sort-moves' },
            button('', { class: 'nx-btn-mini', icon: icon(horizontal ? 'left' : 'up', 28), ariaLabel: `Move ${it.label} ${horizontal ? 'left' : 'up'}`, onClick: () => moveBy(id, -1), disabled: idx === 0 }),
            button('', { class: 'nx-btn-mini', icon: icon(horizontal ? 'right' : 'down', 28), ariaLabel: `Move ${it.label} ${horizontal ? 'right' : 'down'}`, onClick: () => moveBy(id, 1), disabled: idx === order.length - 1 }),
          )
        : null;
      list.appendChild(h('li', { class: 'nx-sort-item', attrs: { 'data-item-id': id } }, cardEl, moves));
    });
  }

  function check(): void {
    if (solved) return;
    attempts++;
    const r = evaluateSequence(order, i);
    positions = r.positions;
    selected = null;
    host.report('attempt', { correct: r.correct, attempt: attempts });
    render();
    if (r.correct) {
      solved = true;
      host.sound.success();
      frame.setFeedback('success', host.scene.feedback.success);
      frame.showNext(() => host.complete());
      host.emit({ type: 'correct-answer' });
      return;
    }
    host.sound.error();
    frame.setFeedback('error', `${r.correctCount} of ${order.length} cards are in the right place. ${host.scene.feedback.error}`);
    if (hintNudgeDue(host, attempts)) frame.nudgeHint();
    host.emit({ type: 'retry-requested' });
  }

  function hint(): void {
    if (solved) return;
    const step = hints.next();
    host.report('hint', { hintLevel: step.level });
    if (step.final) {
      const evalNow = evaluateSequence(order, i);
      const k = evalNow.positions.findIndex((ok) => !ok);
      if (k >= 0) {
        const want = solvedSequence(i)[k]!;
        // With equal values or interchangeable groups, any equivalent item will do; prefer one not already correct.
        const candidates = order.filter((id, idx) => idx >= k && evaluateSequence([...order.slice(0, k), id, ...order.filter((o, oi) => o !== id && oi >= k)], i).positions[k]);
        const pick = candidates[0] ?? want;
        order = [...order.slice(0, k), pick, ...order.filter((o, oi) => o !== pick && oi >= k)];
        hinted.add(pick);
        positions = null;
        render();
      }
    }
    frame.setFeedback('hint', step.text);
    host.emit({ type: 'instruction-advanced' });
  }

  function reset(): void {
    if (solved) return;
    order = sortStartOrder(i, host.config.settings.seed, host.scene.id);
    selected = null;
    positions = null;
    hinted.clear();
    render();
    frame.setFeedback('neutral', '');
  }

  render();
  return {
    el: frame.root,
    mount() {
      frame.layout();
    },
    onKey(e) {
      if (!selected || solved) return false;
      const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
      const fwd = horizontal ? 'ArrowRight' : 'ArrowDown';
      if (e.key === back) {
        moveBy(selected, -1);
        return true;
      }
      if (e.key === fwd) {
        moveBy(selected, 1);
        return true;
      }
      if (e.key === 'Escape') {
        const id = selected;
        selected = null;
        render();
        list.querySelector<HTMLElement>(`[data-item="${id}"]`)?.focus();
        return true;
      }
      return false;
    },
    destroy() {
      for (const c of cleanups.splice(0)) c();
    },
  };
}
