import { computeGridLayout, toScreen } from '@shared/coords.ts';
import type { InfoInteraction } from '@shared/schemas/interaction.ts';
import { icon } from '../art.ts';
import { button, fitText, h, s } from '../dom.ts';
import type { SceneController, SceneHost } from '../types.ts';

function illustration(kind: InfoInteraction['illustration'], host: SceneHost): SVGSVGElement | null {
  if (kind === 'none') return null;
  const p = host.config.theme.palette;
  const W = 520;
  const H = 420;
  const svg = s('svg', { class: 'nx-info-art', viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', focusable: 'false' });
  const L = computeGridLayout({ xMin: -4, xMax: 4, yMin: -3, yMax: 3, step: 1 }, { x: 0, y: 0, width: W, height: H }, 40);
  svg.append(s('rect', { x: 8, y: 8, width: W - 16, height: H - 16, rx: 24, fill: p.surface }));
  for (let x = -4; x <= 4; x++) {
    const { sx } = toScreen(L, { x, y: 0 });
    svg.append(s('line', { x1: sx, y1: L.top, x2: sx, y2: L.top + L.height, stroke: p.gridLine, 'stroke-width': 1.5 }));
  }
  for (let y = -3; y <= 3; y++) {
    const { sy } = toScreen(L, { x: 0, y });
    svg.append(s('line', { x1: L.left, y1: sy, x2: L.left + L.width, y2: sy, stroke: p.gridLine, 'stroke-width': 1.5 }));
  }
  const o = toScreen(L, { x: 0, y: 0 });
  if (kind === 'quadrants') {
    const labels: Array<[string, number, number]> = [['I', 2, 1.5], ['II', -2, 1.5], ['III', -2, -1.5], ['IV', 2, -1.5]];
    for (const [t, x, y] of labels) {
      const at = toScreen(L, { x, y });
      svg.append(s('text', { x: at.sx, y: at.sy + 14, 'text-anchor': 'middle', 'font-size': 40, 'font-weight': 800, fill: p.primary }, t));
    }
  } else {
    const at = toScreen(L, { x: 3, y: 2 });
    svg.append(
      s('path', { d: `M${o.sx} ${o.sy}H${at.sx}V${at.sy}`, fill: 'none', stroke: p.accent, 'stroke-width': 5, 'stroke-dasharray': '10 8', 'stroke-linecap': 'round' }),
      s('circle', { cx: at.sx, cy: at.sy, r: 12, fill: p.accent }),
      s('text', { x: at.sx + 16, y: at.sy - 14, 'font-size': 28, 'font-weight': 800, fill: p.surfaceText }, '(3, 2)'),
    );
  }
  svg.append(
    s('line', { x1: L.left, y1: o.sy, x2: L.left + L.width, y2: o.sy, stroke: p.gridAxis, 'stroke-width': 4 }),
    s('line', { x1: o.sx, y1: L.top, x2: o.sx, y2: L.top + L.height, stroke: p.gridAxis, 'stroke-width': 4 }),
    s('text', { x: L.left + L.width - 4, y: o.sy - 10, 'text-anchor': 'end', 'font-size': 26, 'font-weight': 800, fill: p.surfaceText }, 'x'),
    s('text', { x: o.sx + 10, y: L.top + 24, 'font-size': 26, 'font-weight': 800, fill: p.surfaceText }, 'y'),
  );
  return svg;
}

/** Concept card: short points and an optional illustration, then Continue. */
export function infoScene(host: SceneHost): SceneController {
  const i = host.scene.interaction as InfoInteraction;
  const heading = h('h2', { class: 'nx-scene-title', text: host.scene.title, attrs: { tabindex: -1 } });
  const lead = h('p', { class: 'nx-instruction', text: host.scene.instruction });
  const points = h('ul', { class: 'nx-info-points', attrs: { 'data-entity': 'points' } }, ...i.points.map((pt, k) => h('li', { text: pt, attrs: { 'data-entity': `point:${k + 1}` } })));
  const next = button(i.continueLabel, {
    class: 'nx-btn-primary nx-btn-next',
    icon: icon('next', 30),
    onClick: () => {
      host.emit({ type: 'control-activated', control: 'continue' });
      host.report('attempt', { correct: true, attempt: 1 });
      host.complete();
    },
  });
  next.setAttribute('data-entity', 'button:continue');
  const art = illustration(i.illustration, host);
  const card = h('section', { class: `nx-info-card${art ? ' nx-has-art' : ''}`, attrs: { 'data-entity': 'instruction' } }, h('div', { class: 'nx-info-text' }, heading, lead, points, h('div', { class: 'nx-info-actions' }, next)), art);
  const root = h('div', { class: 'nx-scene nx-scene-info', attrs: { 'data-scene-id': host.scene.id, 'data-type': 'info' } }, card);
  return {
    el: root,
    mount() {
      fitText(points, 22);
    },
    destroy() {},
  };
}
