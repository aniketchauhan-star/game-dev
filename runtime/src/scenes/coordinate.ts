import { computeGridLayout, formatNumber, formatPoint, snapToGrid, speakPoint, stepPoint, tickValues, toMath, toScreen, type GridLayout } from '@shared/coords.ts';
import { coordinateFeedback, evaluateCoordinate } from '@shared/rules.ts';
import type { CoordinateInteraction, Point } from '@shared/schemas/interaction.ts';
import { THEME_PRESETS } from '@shared/themes.ts';
import { icon, landmarkArt, moverArt } from '../art.ts';
import { button, clear, h, s } from '../dom.ts';
import type { SceneController, SceneHost } from '../types.ts';
import { buildFrame, hintNudgeDue, HintLadder } from './frame.ts';

/**
 * Coordinate navigation. Mathematical y points up and screen y points down;
 * every position goes through shared/coords.ts so drawing, input and checking
 * agree. Moves by arrow keys, on-screen buttons, tapping a grid point, or drag.
 */
export function coordinateScene(host: SceneHost): SceneController {
  const i = host.scene.interaction as CoordinateInteraction;
  const p = host.config.theme.palette;
  const large = i.display.pointSize === 'large';
  let pos: Point = { ...i.start };
  let attempts = 0;
  let solved = false;
  let revealTarget = false;
  let layout: GridLayout | null = null;
  const pointTargets: Point[] = i.rule.kind === 'point-equals' ? [i.rule.target] : i.rule.kind === 'point-in-set' ? i.rule.targets : [];
  const hints = new HintLadder(host.scene.feedback.hints, pointTargets.length ? 'Show me: the target is now marked on the grid.' : i.rule.kind === 'in-quadrant' ? 'Show me: the correct quadrant is now shaded.' : 'Show me: the axis is now highlighted.');

  const live = h('p', { class: 'nx-sr-only', attrs: { 'aria-live': 'polite' } });
  const svg = s('svg', { class: 'nx-coord', 'aria-hidden': 'true', focusable: 'false' });
  const gridWrap = h(
    'div',
    {
      class: 'nx-coord-wrap',
      attrs: {
        tabindex: 0,
        role: 'application',
        'aria-roledescription': 'coordinate grid',
        'aria-label': `Coordinate grid from x ${i.grid.xMin} to ${i.grid.xMax} and y ${i.grid.yMin} to ${i.grid.yMax}. Use the arrow keys to move ${i.moverLabel || 'the mover'}, Enter to check.`,
        'data-entity': 'grid',
      },
    },
    svg,
    live,
  );

  const pad = (label: string, iconName: string, dx: number, dy: number) =>
    button('', { class: `nx-btn-pad nx-pad-${iconName}`, icon: icon(iconName, 40), ariaLabel: label, onClick: () => move(dx, dy) });
  const dpad = h('div', { class: 'nx-dpad', attrs: { role: 'group', 'aria-label': 'Move' } }, pad('Move up', 'up', 0, 1), pad('Move left', 'left', -1, 0), pad('Move right', 'right', 1, 0), pad('Move down', 'down', 0, -1));
  const readout = h('p', { class: 'nx-readout', attrs: { 'aria-hidden': 'true' } });

  const frame = buildFrame(host, { checkLabel: 'Check position', onCheck: check, onReset: reset, onHint: hint, extraControls: [h('div', { class: 'nx-pad-wrap' }, dpad, i.showCoordinateReadout ? readout : null)] });
  frame.area.appendChild(gridWrap);

  const moverLayer = s('g', { class: 'nx-mover', 'data-entity': 'mover' });
  const markerLayer = s('g', { class: 'nx-markers' });
  const highlightLayer = s('g', { class: 'nx-highlight' });

  function draw(): void {
    const W = gridWrap.clientWidth;
    const H = gridWrap.clientHeight;
    if (W < 10 || H < 10) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    const labelSize = i.display.labelSize === 'large' ? 32 : 26;
    layout = computeGridLayout(i.grid, { x: 0, y: 0, width: W, height: H }, labelSize * 1.9);
    const L = layout;
    // Stage pixels per grid unit, for motion measured in grid units.
    gridWrap.setAttribute('data-unit', String(L.unit));
    clear(svg);
    svg.append(s('rect', { x: L.left - 30, y: L.top - 30, width: L.width + 60, height: L.height + 60, rx: 28, fill: p.surface, opacity: 0.94 }));
    svg.append(highlightLayer);
    const strong = i.display.gridEmphasis === 'high';
    const xs = tickValues(i.grid.xMin, i.grid.xMax, i.grid.step);
    const ys = tickValues(i.grid.yMin, i.grid.yMax, i.grid.step);
    for (const x of xs) {
      const { sx } = toScreen(L, { x, y: 0 });
      svg.append(s('line', { x1: sx, y1: L.top, x2: sx, y2: L.top + L.height, stroke: strong ? p.gridAxis : p.gridLine, 'stroke-width': strong ? 2.2 : 1.6, opacity: strong ? 0.55 : 1 }));
    }
    for (const y of ys) {
      const { sy } = toScreen(L, { x: 0, y });
      svg.append(s('line', { x1: L.left, y1: sy, x2: L.left + L.width, y2: sy, stroke: strong ? p.gridAxis : p.gridLine, 'stroke-width': strong ? 2.2 : 1.6, opacity: strong ? 0.55 : 1 }));
    }
    // Axes with arrowheads.
    const o = toScreen(L, { x: 0, y: 0 });
    const axisW = strong ? 6 : 4.5;
    svg.append(
      s('line', { x1: L.left - 18, y1: o.sy, x2: L.left + L.width + 18, y2: o.sy, stroke: p.gridAxis, 'stroke-width': axisW, 'stroke-linecap': 'round' }),
      s('line', { x1: o.sx, y1: L.top + L.height + 18, x2: o.sx, y2: L.top - 18, stroke: p.gridAxis, 'stroke-width': axisW, 'stroke-linecap': 'round' }),
      s('path', { d: `M${L.left + L.width + 30} ${o.sy}l-16 -10v20z`, fill: p.gridAxis }),
      s('path', { d: `M${o.sx} ${L.top - 30}l-10 16h20z`, fill: p.gridAxis }),
      s('text', { x: L.left + L.width + 34, y: o.sy + labelSize * 0.35, 'font-size': labelSize + 4, 'font-weight': 800, fill: p.surfaceText, class: 'nx-axis-name' }, 'x'),
      s('text', { x: o.sx + 14, y: L.top - 26, 'font-size': labelSize + 4, 'font-weight': 800, fill: p.surfaceText, class: 'nx-axis-name' }, 'y'),
    );
    const every = L.unit * i.grid.step < labelSize * 1.9 ? 2 : 1;
    xs.forEach((x, k) => {
      if (x === 0 || k % every) return;
      const { sx } = toScreen(L, { x, y: 0 });
      svg.append(s('text', { x: sx, y: o.sy + labelSize + 10, 'text-anchor': 'middle', 'font-size': labelSize, fill: p.surfaceText, class: 'nx-tick' }, formatNumber(x)));
    });
    ys.forEach((y, k) => {
      if (y === 0 || k % every) return;
      const { sy } = toScreen(L, { x: 0, y });
      svg.append(s('text', { x: o.sx - 12, y: sy + labelSize * 0.35, 'text-anchor': 'end', 'font-size': labelSize, fill: p.surfaceText, class: 'nx-tick' }, formatNumber(y)));
    });
    svg.append(s('text', { x: o.sx - 12, y: o.sy + labelSize + 10, 'text-anchor': 'end', 'font-size': labelSize, fill: p.surfaceText, class: 'nx-tick' }, '0'));
    // Landmarks.
    for (const l of i.landmarks) {
      const at = toScreen(L, l.point);
      const g = s('g', { class: 'nx-landmark', transform: `translate(${at.sx - 24} ${at.sy - 24})`, 'data-entity': `landmark:${l.id}` });
      g.append(landmarkArt(l.icon, p));
      // Label above the icon, so it never collides with the mover's own label (drawn below the mover).
      const tw = l.label.length * labelSize * 0.56 + 24;
      const lh = labelSize + 14;
      g.append(s('rect', { x: 24 - tw / 2, y: -lh - 6, width: tw, height: lh, rx: lh / 2, fill: p.surface, stroke: p.gridAxis, 'stroke-width': 2 }));
      g.append(s('text', { x: 24, y: -lh - 6 + labelSize, 'text-anchor': 'middle', 'font-size': labelSize * 0.85, 'font-weight': 700, fill: p.surfaceText }, l.label));
      svg.append(g);
    }
    svg.append(markerLayer, moverLayer);
    clear(moverLayer);
    drawMarkers();
    drawMover(false);
  }

  // Redraw when the available space changes (for example when feedback grows the instruction panel).
  let lastSize = '';
  const resizeObserver = new ResizeObserver(() => {
    const size = `${gridWrap.clientWidth}x${gridWrap.clientHeight}`;
    if (size === lastSize) return;
    lastSize = size;
    draw();
  });

  function drawMarkers(): void {
    clear(markerLayer);
    clear(highlightLayer);
    if (!layout) return;
    const L = layout;
    if ((i.showTargetMarker || revealTarget) && pointTargets.length) {
      for (const t of pointTargets) {
        const at = toScreen(L, t);
        const r = large ? 30 : 24;
        markerLayer.append(
          s('circle', { cx: at.sx, cy: at.sy, r: r + 10, fill: p.accent, opacity: 0.18, class: host.reducedMotion ? '' : 'nx-pulse' }),
          s('circle', { cx: at.sx, cy: at.sy, r, fill: 'none', stroke: p.accent, 'stroke-width': 6 }),
          s('circle', { cx: at.sx, cy: at.sy, r: 6, fill: p.accent }),
        );
      }
    }
    if (revealTarget && i.rule.kind === 'in-quadrant') {
      const q = i.rule.quadrant;
      const x0 = q === 1 || q === 4 ? 0 : i.grid.xMin;
      const x1 = q === 1 || q === 4 ? i.grid.xMax : 0;
      const y0 = q === 1 || q === 2 ? i.grid.yMax : 0;
      const y1 = q === 1 || q === 2 ? 0 : i.grid.yMin;
      const a = toScreen(L, { x: x0, y: y0 });
      const b = toScreen(L, { x: x1, y: y1 });
      highlightLayer.append(s('rect', { x: Math.min(a.sx, b.sx), y: Math.min(a.sy, b.sy), width: Math.abs(b.sx - a.sx), height: Math.abs(b.sy - a.sy), fill: p.accent, opacity: 0.16 }));
    }
    if (revealTarget && i.rule.kind === 'on-axis') {
      const o = toScreen(L, { x: 0, y: 0 });
      highlightLayer.append(
        i.rule.axis === 'x'
          ? s('rect', { x: L.left, y: o.sy - 14, width: L.width, height: 28, fill: p.accent, opacity: 0.22, rx: 14 })
          : s('rect', { x: o.sx - 14, y: L.top, width: 28, height: L.height, fill: p.accent, opacity: 0.22, rx: 14 }),
      );
    }
  }

  function drawMover(animate: boolean): void {
    if (!layout) return;
    const L = layout;
    const at = toScreen(L, pos);
    const size = Math.max(56, Math.min(large ? 112 : 92, L.unit * i.grid.step * 1.15));
    if (!moverLayer.firstChild) {
      const charUrl = host.assetUrl(host.scene.assets.character);
      const body = s('g', { class: 'nx-mover-body' });
      if (charUrl) {
        body.append(s('image', { href: charUrl, x: -size / 2, y: -size / 2, width: size, height: size, preserveAspectRatio: 'xMidYMid meet' }));
      } else {
        const kind = THEME_PRESETS[host.config.theme.presetId as keyof typeof THEME_PRESETS]?.mover ?? 'marker';
        const art = moverArt(kind, p);
        art.setAttribute('transform', `translate(${-size / 2} ${-size / 2}) scale(${size / 100})`);
        body.append(art);
      }
      moverLayer.append(s('circle', { cx: 0, cy: 0, r: 7, fill: p.accent, stroke: '#FFFFFF', 'stroke-width': 3 }), body);
      if (i.moverLabel) {
        const fs = i.display.labelSize === 'large' ? 26 : 22;
        const w = i.moverLabel.length * fs * 0.62 + 22;
        moverLayer.append(
          s('rect', { x: -w / 2, y: size / 2 + 4, width: w, height: fs + 12, rx: (fs + 12) / 2, fill: p.primary }),
          s('text', { x: 0, y: size / 2 + fs + 6, 'text-anchor': 'middle', 'font-size': fs, 'font-weight': 800, fill: p.primaryText }, i.moverLabel),
        );
      }
    }
    moverLayer.classList.toggle('nx-animate', animate && !host.reducedMotion);
    moverLayer.style.setProperty('transform', `translate(${at.sx}px, ${at.sy}px)`);
    readout.textContent = `${i.moverLabel ? `${i.moverLabel} at ` : ''}${formatPoint(pos)}`;
  }

  function announce(): void {
    live.textContent = `${i.moverLabel || 'Mover'} at ${speakPoint(pos)}`;
  }

  function setPos(next: Point, animate = true): void {
    if (solved) return;
    const snapped = snapToGrid(next, i.grid);
    if (snapped.x === pos.x && snapped.y === pos.y) return;
    pos = snapped;
    host.sound.move();
    drawMover(animate);
    announce();
  }

  function move(dx: number, dy: number): void {
    setPos(stepPoint(pos, i.grid, dx, dy));
  }

  function svgPoint(e: PointerEvent): Point | null {
    if (!layout) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return toMath(layout, pt.x, pt.y);
  }

  let dragging = false;
  gridWrap.addEventListener('pointerdown', (e) => {
    if (solved) return;
    const pt = svgPoint(e);
    if (!pt) return;
    gridWrap.focus();
    host.yieldToInput('mover');
    dragging = true;
    gridWrap.setPointerCapture(e.pointerId);
    setPos(pt);
  });
  gridWrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const pt = svgPoint(e);
    if (pt) setPos(pt, false);
  });
  const endDrag = () => {
    dragging = false;
  };
  gridWrap.addEventListener('pointerup', endDrag);
  gridWrap.addEventListener('pointercancel', endDrag);
  gridWrap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!solved) check();
    }
  });

  function check(): void {
    if (solved) return;
    attempts++;
    const ok = evaluateCoordinate(pos, i.rule);
    host.report('attempt', { correct: ok, attempt: attempts });
    if (ok) {
      solved = true;
      host.sound.success();
      moverLayer.classList.add('nx-celebrate');
      frame.setFeedback('success', host.scene.feedback.success);
      frame.showNext(() => host.complete());
      host.emit({ type: 'correct-answer', entities: ['mover'] });
      return;
    }
    host.sound.error();
    const diagnosis = coordinateFeedback(pos, i.rule, hints.level >= 2);
    frame.setFeedback('error', attempts === 1 ? `${diagnosis} ${host.scene.feedback.error}` : diagnosis);
    if (hintNudgeDue(host, attempts)) frame.nudgeHint();
    host.emit({ type: 'retry-requested', entities: ['mover'] });
  }

  function hint(): void {
    if (solved) return;
    const h2 = hints.next();
    if (h2.final) {
      revealTarget = true;
      drawMarkers();
    }
    host.report('hint', { hintLevel: h2.level });
    frame.setFeedback('hint', h2.text);
    host.emit({ type: 'instruction-advanced' });
  }

  function reset(): void {
    if (solved) return;
    pos = { ...i.start };
    drawMover(true);
    announce();
    frame.setFeedback('neutral', '');
  }

  return {
    el: frame.root,
    mount() {
      frame.layout();
      draw();
      lastSize = `${gridWrap.clientWidth}x${gridWrap.clientHeight}`;
      resizeObserver.observe(gridWrap);
      announce();
    },
    onKey(e) {
      if (solved) return false;
      const map: Record<string, [number, number]> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
      const d = map[e.key];
      if (!d) return false;
      move(d[0], d[1]);
      return true;
    },
    destroy() {
      dragging = false;
      resizeObserver.disconnect();
    },
  };
}
