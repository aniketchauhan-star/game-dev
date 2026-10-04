import { evaluateMatch, findMatchAssignment, type MatchItemResult } from '@shared/rules.ts';
import { sceneSeed, seededShuffle } from '@shared/rng.ts';
import type { MatchInteraction } from '@shared/schemas/interaction.ts';
import { icon } from '../art.ts';
import { clear, h } from '../dom.ts';
import type { SceneController, SceneHost } from '../types.ts';
import { hitTest, makeDraggable } from './drag.ts';
import { buildFrame, hintNudgeDue, HintLadder } from './frame.ts';

export interface MatchSceneDeps {
  overlay: HTMLElement;
  toStage: (x: number, y: number) => { x: number; y: number };
}

/**
 * Drag-and-match. Items can be dragged onto targets, or selected (click, tap,
 * Enter/Space) and then placed by activating a target — no dragging required.
 * Several correct arrangements are accepted when the rule allows them.
 */
export function matchScene(host: SceneHost, deps: MatchSceneDeps): SceneController {
  const i = host.scene.interaction as MatchInteraction;
  const placements: Record<string, string | null> = Object.fromEntries(i.items.map((it) => [it.id, null]));
  const trayOrder = seededShuffle(i.items.map((it) => it.id), sceneSeed(host.config.settings.seed, host.scene.id));
  let selected: string | null = null;
  let solved = false;
  let attempts = 0;
  let results: Record<string, MatchItemResult> | null = null;
  const hintedItems = new Set<string>();
  const hints = new HintLadder(host.scene.feedback.hints, 'Show me: one item has been placed for you.');
  const cleanups: Array<() => void> = [];

  const frame = buildFrame(host, { checkLabel: 'Check matches', onCheck: check, onReset: reset, onHint: hint });
  const trayList = h('div', { class: 'nx-tray-items', attrs: { role: 'list' } });
  const tray = h(
    'div',
    { class: 'nx-tray', attrs: { role: 'region', 'aria-label': 'Items to place', 'data-entity': 'tray' } },
    h('p', { class: 'nx-tray-title', text: 'Items' }),
    trayList,
  );
  const trayReturn = h('button', { class: 'nx-btn nx-btn-secondary nx-tray-return', attrs: { type: 'button', hidden: true }, text: 'Return to tray', on: { click: () => place(selected, null) } });
  tray.appendChild(trayReturn);
  const bays = h('div', { class: 'nx-bays', attrs: { role: 'list', 'data-count': i.targets.length } });
  const board = h('div', { class: `nx-match nx-tray-${i.trayPosition}` }, bays, tray);
  frame.area.appendChild(board);

  const itemById = new Map(i.items.map((it) => [it.id, it]));
  const targetById = new Map(i.targets.map((t) => [t.id, t]));

  function card(itemId: string): HTMLElement {
    const it = itemById.get(itemId)!;
    const url = host.assetUrl(it.imageAssetId);
    const state = results?.[itemId];
    const isSel = selected === itemId;
    const where = placements[itemId] ? `in ${targetById.get(placements[itemId]!)?.label}` : 'in the tray';
    const stateText = state === 'correct' ? 'correct' : state === 'incorrect' || state === 'distractor-placed' ? 'not correct yet' : '';
    const el = h(
      'button',
      {
        class: `nx-card${isSel ? ' nx-selected' : ''}${state ? ` nx-state-${state}` : ''}${hintedItems.has(itemId) ? ' nx-hinted' : ''}`,
        attrs: { type: 'button', 'aria-pressed': isSel, 'aria-label': `${it.label}, ${where}${stateText ? `, ${stateText}` : ''}. ${isSel ? 'Selected — now choose where to place it.' : 'Select to move.'}`, 'data-item': itemId, 'data-entity': `item:${itemId}` },
      },
      url ? h('img', { class: 'nx-card-img', attrs: { src: url, alt: '', draggable: 'false' } }) : null,
      h('span', { class: 'nx-card-label', text: it.label }),
      state === 'correct' ? h('span', { class: 'nx-card-mark nx-mark-ok' }, icon('check', 26)) : null,
      state === 'incorrect' || state === 'distractor-placed' ? h('span', { class: 'nx-card-mark nx-mark-bad' }, icon('x', 26)) : null,
    );
    cleanups.push(
      makeDraggable(el, {
        overlay: deps.overlay,
        toStage: deps.toStage,
        onStart: () => {
          selected = itemId;
          board.classList.add('nx-drag-active');
          host.yieldToInput(`item:${itemId}`);
          host.emit({ type: 'object-selected', entities: [`item:${itemId}`] });
        },
        onDrop: (x, y) => {
          board.classList.remove('nx-drag-active');
          const bay = hitTest(x, y, '.nx-bay');
          const toTray = hitTest(x, y, '.nx-tray');
          if (bay) place(itemId, bay.getAttribute('data-target'));
          else if (toTray) place(itemId, null);
          else render();
        },
        onTap: () => select(itemId),
      }),
    );
    return el;
  }

  function render(): void {
    for (const c of cleanups.splice(0)) c();
    clear(trayList);
    for (const id of trayOrder) if (placements[id] === null) trayList.appendChild(h('div', { attrs: { role: 'listitem' } }, card(id)));
    if (trayList.childElementCount === 0) trayList.appendChild(h('p', { class: 'nx-empty', text: 'All items are placed.' }));
    clear(bays);
    for (const t of i.targets) {
      const placed = i.items.filter((it) => placements[it.id] === t.id).map((it) => it.id);
      const url = host.assetUrl(t.imageAssetId);
      const full = placed.length >= t.capacity;
      const bay = h(
        'div',
        { class: `nx-bay${full ? ' nx-full' : ''}`, attrs: { role: 'listitem', 'data-target': t.id, 'data-entity': `target:${t.id}` } },
        h(
          'button',
          {
            class: 'nx-bay-head',
            attrs: { type: 'button', 'aria-label': `${t.label}: ${placed.length} of ${t.capacity} places used.${selected ? ' Place the selected item here.' : ''}`, 'aria-disabled': !selected },
            on: { click: () => (selected ? place(selected, t.id) : undefined) },
          },
          url ? h('img', { class: 'nx-bay-img', attrs: { src: url, alt: '' } }) : null,
          h('span', { class: 'nx-bay-label', text: t.label }),
          h('span', { class: 'nx-bay-count', text: `${placed.length}/${t.capacity}`, attrs: { 'aria-hidden': 'true' } }),
        ),
        h('div', { class: 'nx-bay-slots' }, ...placed.map((id) => card(id))),
      );
      bays.appendChild(bay);
    }
    trayReturn.hidden = !(selected && placements[selected] !== null);
    board.classList.toggle('nx-has-selection', Boolean(selected));
  }

  function select(itemId: string): void {
    if (solved) return;
    selected = selected === itemId ? null : itemId;
    render();
    const again = board.querySelector<HTMLElement>(`[data-item="${itemId}"]`);
    again?.focus();
    if (selected) host.emit({ type: 'object-selected', entities: [`item:${itemId}`] });
  }

  function place(itemId: string | null, targetId: string | null): void {
    if (solved || !itemId) return;
    if (targetId) {
      const t = targetById.get(targetId)!;
      const used = i.items.filter((it) => placements[it.id] === targetId && it.id !== itemId).length;
      if (used >= t.capacity) {
        host.sound.error();
        frame.setFeedback('error', `${t.label} is full. Move an item out of it first.`);
        render();
        return;
      }
    }
    placements[itemId] = targetId;
    if (results) delete results[itemId];
    selected = null;
    host.sound.place();
    render();
    const again = board.querySelector<HTMLElement>(`[data-item="${itemId}"]`);
    again?.focus();
    // A valid placement (the mechanic accepted it); correctness is only judged on Check.
    if (targetId) host.emit({ type: 'valid-drop', entities: [`target:${targetId}`, `item:${itemId}`] });
  }

  function check(): void {
    if (solved) return;
    attempts++;
    const r = evaluateMatch(placements, i);
    results = r.items;
    host.report('attempt', { correct: r.correct, attempt: attempts });
    if (r.correct) {
      solved = true;
      selected = null;
      render();
      host.sound.success();
      frame.setFeedback('success', host.scene.feedback.success);
      frame.showNext(() => host.complete());
      host.emit({ type: 'correct-answer' });
      return;
    }
    render();
    host.sound.error();
    const unplaced = Object.values(r.items).filter((x) => x === 'unplaced').length;
    const parts = [`${r.correctCount} of ${r.requiredCount} placed correctly.`];
    if (unplaced) parts.push(`${unplaced} still in the tray.`);
    parts.push(host.scene.feedback.error);
    frame.setFeedback('error', parts.join(' '));
    if (hintNudgeDue(host, attempts)) frame.nudgeHint();
    host.emit({ type: 'retry-requested' });
  }

  function hint(): void {
    if (solved) return;
    const step = hints.next();
    host.report('hint', { hintLevel: step.level });
    if (step.final) {
      // Place one item correctly, consistent with a full valid arrangement.
      const assignment = findMatchAssignment(i) ?? {};
      const current = evaluateMatch(placements, i).items;
      const wrong = (id: string) => current[id] === 'unplaced' || current[id] === 'incorrect' || current[id] === 'distractor-placed';
      const candidate = i.items.find((it) => wrong(it.id) && !hintedItems.has(it.id));
      if (candidate) {
        const accepted = i.rule.accepts.find((a) => a.itemId === candidate.id)?.targetIds ?? [];
        // Distractors belong in the tray; others go to a bay that accepts them, preferring the full-solution bay.
        const ordered = [assignment[candidate.id], ...accepted].filter((t, k, arr): t is string => Boolean(t) && arr.indexOf(t) === k);
        let destination: string | null = null;
        for (const t of ordered) {
          const others = i.items.filter((it) => placements[it.id] === t && it.id !== candidate.id);
          if (others.length < targetById.get(t)!.capacity) {
            destination = t;
            break;
          }
          const evict = others.find((it) => wrong(it.id));
          if (evict) {
            placements[evict.id] = null;
            destination = t;
            break;
          }
        }
        if (accepted.length === 0 || destination) {
          placements[candidate.id] = destination;
          hintedItems.add(candidate.id);
          results = null;
          render();
        }
      }
    }
    frame.setFeedback('hint', step.text);
    host.emit({ type: 'instruction-advanced' });
  }

  function reset(): void {
    if (solved) return;
    for (const id of Object.keys(placements)) placements[id] = null;
    selected = null;
    results = null;
    hintedItems.clear();
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
      if (e.key === 'Escape' && selected) {
        selected = null;
        render();
        return true;
      }
      return false;
    },
    destroy() {
      for (const c of cleanups.splice(0)) c();
    },
  };
}
