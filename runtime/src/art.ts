import { s } from './dom.ts';
import type { Decor, Palette } from '@shared/schemas/game.ts';

/** Built-in SVG icons (24×24, stroke-based) and theme artwork drawn by trusted code. */

const ICONS: Record<string, string[]> = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  hint: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z'],
  reset: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'],
  soundOn: ['M4 9v6h4l5 4V5L8 9H4z', 'M16.5 8.5a5 5 0 0 1 0 7', 'M19 6a8.5 8.5 0 0 1 0 12'],
  soundOff: ['M4 9v6h4l5 4V5L8 9H4z', 'M17 9l5 6', 'M22 9l-5 6'],
  up: ['M12 19V5', 'M5 12l7-7 7 7'],
  down: ['M12 5v14', 'M19 12l-7 7-7-7'],
  left: ['M19 12H5', 'M12 19l-7-7 7-7'],
  right: ['M5 12h14', 'M12 5l7 7-7 7'],
  play: ['M7 4.5v15l12-7.5z'],
  next: ['M5 12h13', 'M13 6l6 6-6 6'],
  info: ['M12 8h.01', 'M11 12h1v5h1', 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z'],
  target: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z'],
  grab: ['M8 10V5a1.5 1.5 0 0 1 3 0v5', 'M11 9V4a1.5 1.5 0 0 1 3 0v5', 'M14 9.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3 13.5a1.5 1.5 0 0 1 2.4-1.8L8 14'],
  pause: ['M8 5v14', 'M16 5v14'],
};

export function icon(name: keyof typeof ICONS | string, size = 32): SVGSVGElement {
  const paths = ICONS[name] ?? ICONS.info!;
  return s(
    'svg',
    { class: 'nx-icon', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    ...paths.map((d) => s('path', { d })),
  );
}

/** Built-in movers drawn in a 100×100 box centered on (50, 50). Used when no character asset is assigned. */
export function moverArt(kind: 'plane' | 'penguin' | 'rocket' | 'bus' | 'marker', p: Palette): SVGGElement {
  const g = s('g', { class: 'nx-mover-art' });
  switch (kind) {
    case 'plane':
      g.append(
        s('path', { d: 'M50 6c5 0 7 7 7 14v18l36 18v9l-36-9v20l11 9v6l-18-5-18 5v-6l11-9V65l-36 9v-9l36-18V20c0-7 2-14 7-14z', fill: '#FFFFFF', stroke: p.primary, 'stroke-width': 4, 'stroke-linejoin': 'round' }),
        s('rect', { x: 46, y: 18, width: 8, height: 10, rx: 3, fill: p.primary }),
        s('rect', { x: 14, y: 52, width: 14, height: 5, rx: 2, fill: p.accent }),
        s('rect', { x: 72, y: 52, width: 14, height: 5, rx: 2, fill: p.accent }),
      );
      break;
    case 'penguin':
      g.append(
        s('ellipse', { cx: 50, cy: 56, rx: 26, ry: 34, fill: '#1E2B3A' }),
        s('ellipse', { cx: 50, cy: 62, rx: 17, ry: 25, fill: '#FFFFFF' }),
        s('circle', { cx: 42, cy: 40, r: 4, fill: '#FFFFFF' }),
        s('circle', { cx: 58, cy: 40, r: 4, fill: '#FFFFFF' }),
        s('circle', { cx: 42, cy: 40, r: 2, fill: '#1E2B3A' }),
        s('circle', { cx: 58, cy: 40, r: 2, fill: '#1E2B3A' }),
        s('path', { d: 'M44 48l6 7 6-7z', fill: p.accent }),
        s('path', { d: 'M36 90h10M54 90h10', stroke: p.accent, 'stroke-width': 6, 'stroke-linecap': 'round' }),
      );
      break;
    case 'rocket':
      g.append(
        s('path', { d: 'M50 4c14 12 20 30 20 50v20H30V54C30 34 36 16 50 4z', fill: '#FFFFFF', stroke: p.primary, 'stroke-width': 4 }),
        s('circle', { cx: 50, cy: 40, r: 9, fill: p.primary }),
        s('path', { d: 'M30 60L16 78v8l14-6zM70 60l14 18v8l-14-6z', fill: p.accent }),
        s('path', { d: 'M40 76l10 20 10-20z', fill: '#FFB547' }),
      );
      break;
    case 'bus':
      g.append(
        s('rect', { x: 12, y: 22, width: 76, height: 52, rx: 10, fill: p.accent, stroke: '#1E2430', 'stroke-width': 4 }),
        s('rect', { x: 20, y: 30, width: 18, height: 16, rx: 3, fill: '#E8F4FF' }),
        s('rect', { x: 42, y: 30, width: 18, height: 16, rx: 3, fill: '#E8F4FF' }),
        s('rect', { x: 64, y: 30, width: 16, height: 16, rx: 3, fill: '#E8F4FF' }),
        s('circle', { cx: 30, cy: 76, r: 8, fill: '#1E2430' }),
        s('circle', { cx: 70, cy: 76, r: 8, fill: '#1E2430' }),
      );
      break;
    default:
      g.append(
        s('path', { d: 'M50 92C50 92 20 60 20 40a30 30 0 0 1 60 0c0 20-30 52-30 52z', fill: p.primary, stroke: '#FFFFFF', 'stroke-width': 4 }),
        s('circle', { cx: 50, cy: 40, r: 12, fill: '#FFFFFF' }),
      );
  }
  return g;
}

/** Landmark icons in a 48×48 box centered on (24, 24). */
export function landmarkArt(kind: string, p: Palette): SVGGElement {
  const g = s('g', { class: 'nx-landmark-art' });
  const stroke = { stroke: p.gridAxis, 'stroke-width': 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' } as const;
  switch (kind) {
    case 'runway':
      g.append(s('rect', { x: 6, y: 16, width: 36, height: 16, rx: 3, fill: '#5B6670', ...stroke }), s('path', { d: 'M12 24h6M22 24h6M32 24h4', stroke: '#FFFFFF', 'stroke-width': 3 }));
      break;
    case 'tower':
      g.append(s('path', { d: 'M18 44l3-24h6l3 24z', fill: '#C8CED6', ...stroke }), s('rect', { x: 12, y: 8, width: 24, height: 12, rx: 3, fill: p.primary, ...stroke }));
      break;
    case 'gate':
      g.append(s('path', { d: 'M8 42V16l16-10 16 10v26', fill: 'none', ...stroke }), s('rect', { x: 18, y: 26, width: 12, height: 16, fill: p.accent }));
      break;
    case 'beacon':
      g.append(s('circle', { cx: 24, cy: 24, r: 8, fill: p.accent, ...stroke }), s('path', { d: 'M24 4v6M24 38v6M4 24h6M38 24h6', ...stroke }));
      break;
    case 'star':
      g.append(s('path', { d: 'M24 5l5.6 12 13 1.5-9.7 8.8 2.7 12.9L24 33.8 12.4 40.2l2.7-12.9-9.7-8.8 13-1.5z', fill: '#FFC93C', ...stroke }));
      break;
    case 'flag':
      g.append(s('path', { d: 'M12 44V6', ...stroke }), s('path', { d: 'M12 8h24l-6 8 6 8H12z', fill: p.accent, ...stroke }));
      break;
    case 'home':
      g.append(s('path', { d: 'M6 24L24 8l18 16v18H6z', fill: '#FFFFFF', ...stroke }), s('rect', { x: 19, y: 30, width: 10, height: 12, fill: p.primary }));
      break;
    default:
      g.append(s('circle', { cx: 24, cy: 24, r: 7, fill: p.gridAxis }));
  }
  return g;
}

/** Static theme scenery behind the stage (no permanently moving particles). */
export function decorArt(decor: Decor, p: Palette): SVGSVGElement {
  const svg = s('svg', { class: 'nx-decor', viewBox: '0 0 1920 1080', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(s('rect', { width: 1920, height: 1080, fill: p.background }));
  switch (decor) {
    case 'airport': {
      for (const [x, y, sc] of [[220, 170, 1], [1480, 120, 1.3], [980, 230, 0.8]] as const) {
        svg.append(s('path', { d: `M${x} ${y}c0-30 50-40 66-14 26-18 66 0 58 30 30 4 30 44-6 44H${x - 4}c-40 0-40-56 4-60z`, fill: '#FFFFFF', opacity: 0.85, transform: `scale(${sc})`, 'transform-origin': `${x} ${y}` }));
      }
      svg.append(s('rect', { x: 0, y: 900, width: 1920, height: 180, fill: p.backgroundAlt }));
      svg.append(s('rect', { x: 0, y: 960, width: 1920, height: 70, fill: '#6B7680', opacity: 0.55 }));
      for (let i = 0; i < 16; i++) svg.append(s('rect', { x: 40 + i * 122, y: 990, width: 60, height: 10, rx: 3, fill: '#FFFFFF', opacity: 0.8 }));
      svg.append(s('path', { d: 'M1700 960l10-170h40l10 170z', fill: '#C8CED6', opacity: 0.9 }), s('rect', { x: 1680, y: 750, width: 120, height: 50, rx: 10, fill: p.primary, opacity: 0.85 }));
      break;
    }
    case 'ice': {
      svg.append(s('path', { d: 'M0 860C240 760 420 800 640 860S1100 760 1340 820 1720 900 1920 840V1080H0z', fill: '#FFFFFF', opacity: 0.9 }));
      svg.append(s('path', { d: 'M0 940C300 880 600 960 960 930S1600 880 1920 950V1080H0z', fill: p.backgroundAlt }));
      for (const [x, h2] of [[1580, 220], [1700, 300], [1820, 180]] as const) svg.append(s('path', { d: `M${x - 80} 900L${x} ${900 - h2}L${x + 80} 900z`, fill: '#CFE8F7', stroke: '#FFFFFF', 'stroke-width': 6, opacity: 0.9 }));
      for (let i = 0; i < 26; i++) svg.append(s('circle', { cx: (i * 337) % 1920, cy: (i * 151) % 700, r: 4 + (i % 3), fill: '#FFFFFF', opacity: 0.7 }));
      break;
    }
    case 'space': {
      for (let i = 0; i < 90; i++) svg.append(s('circle', { cx: (i * 397) % 1920, cy: (i * 223) % 1080, r: (i % 4) * 0.7 + 1, fill: '#FFFFFF', opacity: 0.25 + (i % 5) * 0.12 }));
      svg.append(s('circle', { cx: 1660, cy: 210, r: 120, fill: p.accent, opacity: 0.55 }));
      svg.append(s('ellipse', { cx: 1660, cy: 210, rx: 200, ry: 36, fill: 'none', stroke: p.primary, 'stroke-width': 10, opacity: 0.6 }));
      svg.append(s('circle', { cx: 240, cy: 900, r: 260, fill: p.backgroundAlt }));
      break;
    }
    case 'city': {
      const heights = [260, 380, 300, 460, 340, 420, 280, 360, 500, 320, 400, 290];
      heights.forEach((ht, i) => {
        svg.append(s('rect', { x: i * 165, y: 1080 - ht - 120, width: 140, height: ht, rx: 8, fill: i % 2 ? p.backgroundAlt : '#FFFFFF', opacity: 0.85 }));
        for (let r = 0; r < Math.floor(ht / 70); r++) svg.append(s('rect', { x: i * 165 + 24, y: 1080 - ht - 90 + r * 64, width: 30, height: 26, rx: 4, fill: p.primary, opacity: 0.25 }));
      });
      svg.append(s('rect', { x: 0, y: 960, width: 1920, height: 120, fill: '#8C96A3', opacity: 0.5 }));
      for (let i = 0; i < 9; i++) svg.append(s('circle', { cx: 100 + i * 220, cy: 940, r: 40, fill: '#3E9B5C', opacity: 0.75 }));
      break;
    }
    default:
      svg.append(s('rect', { y: 860, width: 1920, height: 220, fill: p.backgroundAlt }));
  }
  return svg;
}
