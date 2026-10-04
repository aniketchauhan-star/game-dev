/**
 * Artwork for the bundled Grade 8 sample “Trapezium Quest” (ice theme). Every
 * picture is drawn here as SVG so the sample is reproducible and licence-clean.
 * Labelled sample content — never presented as a creator's upload.
 */

export const W = 1920;
export const H = 1080;

const NAVY = '#16304F';
const INK = '#0F2740';
const ICE = '#3FB6E8';
const ORANGE = '#F28C28';

function snowflake(x: number, y: number, r: number, opacity = 0.8, rot = 0): string {
  const arms = Array.from({ length: 6 }, (_, i) => {
    const a = (i * 60 * Math.PI) / 180;
    const x2 = Math.cos(a) * r;
    const y2 = Math.sin(a) * r;
    const bx = Math.cos(a) * r * 0.55;
    const by = Math.sin(a) * r * 0.55;
    const b1 = { x: bx + Math.cos(a + 0.7) * r * 0.25, y: by + Math.sin(a + 0.7) * r * 0.25 };
    const b2 = { x: bx + Math.cos(a - 0.7) * r * 0.25, y: by + Math.sin(a - 0.7) * r * 0.25 };
    return `<path d="M0 0 L${x2.toFixed(1)} ${y2.toFixed(1)} M${bx.toFixed(1)} ${by.toFixed(1)} L${b1.x.toFixed(1)} ${b1.y.toFixed(1)} M${bx.toFixed(1)} ${by.toFixed(1)} L${b2.x.toFixed(1)} ${b2.y.toFixed(1)}"/>`;
  }).join('');
  return `<g transform="translate(${x} ${y}) rotate(${rot})" stroke="#FFFFFF" stroke-width="${Math.max(1.5, r / 9).toFixed(1)}" stroke-linecap="round" opacity="${opacity}" fill="none">${arms}</g>`;
}

/** The exact background the creator assigns: sky, icy mountains, sea and ice floes. No text. */
export function iceBackgroundSvg(): string {
  const flakes = [
    [180, 140, 16],
    [420, 90, 10],
    [760, 170, 13],
    [1180, 110, 18],
    [1500, 200, 11],
    [1760, 120, 15],
    [300, 330, 9],
    [1650, 380, 10],
    [980, 260, 8],
  ]
    .map(([x, y, r], i) => snowflake(x!, y!, r!, 0.75, i * 13))
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9ED8F7"/><stop offset="0.6" stop-color="#D9F1FD"/><stop offset="1" stop-color="#F3FBFF"/></linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5FB8DD"/><stop offset="1" stop-color="#2E86B5"/></linearGradient>
    <linearGradient id="mtn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#BFE2F4"/></linearGradient>
    <linearGradient id="floe" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#D3EEFA"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <circle cx="1620" cy="190" r="90" fill="#FFF8D6" opacity="0.85"/>
  <path d="M0 640 L180 430 L330 560 L520 330 L700 520 L860 400 L1040 590 L1240 360 L1420 540 L1600 420 L1780 560 L1920 470 L1920 700 L0 700 Z" fill="url(#mtn)"/>
  <path d="M520 330 L580 400 L540 395 L500 430 L470 390 Z M1240 360 L1300 430 L1260 425 L1220 455 L1195 415 Z" fill="#FFFFFF"/>
  <rect y="640" width="${W}" height="${H - 640}" fill="url(#sea)"/>
  <g opacity="0.35" stroke="#FFFFFF" stroke-width="3" fill="none">
    <path d="M60 720 q40 -12 80 0 t80 0"/><path d="M820 760 q40 -12 80 0 t80 0"/><path d="M1460 735 q40 -12 80 0 t80 0"/>
  </g>
  <ellipse cx="300" cy="905" rx="360" ry="70" fill="#0F5B85" opacity="0.25"/>
  <path d="M-20 880 C120 820 420 820 640 870 L620 930 C400 965 120 960 -20 930 Z" fill="url(#floe)"/>
  <ellipse cx="1500" cy="975" rx="420" ry="60" fill="#0F5B85" opacity="0.22"/>
  <path d="M1100 950 C1250 890 1700 885 1960 930 L1960 1000 C1700 1030 1300 1030 1110 1000 Z" fill="url(#floe)"/>
  <path d="M900 800 C960 780 1060 780 1120 800 L1110 822 C1050 836 970 836 905 822 Z" fill="url(#floe)"/>
  ${flakes}
</svg>`;
}

export interface SwifteePose {
  /** Vertical offset (negative = up). */
  bob: number;
  /** Right wing angle (negative raises it). */
  wing: number;
  /** Left wing angle (positive raises it). */
  leftWing: number;
  blink: boolean;
  sparkles: number;
}

/** 12 frames: idle ×2, wave ×4, celebrate ×4, talk-free neutral ×2 (no lip sync). */
export const SWIFTEE_POSES: SwifteePose[] = [
  { bob: 0, wing: 0, leftWing: 0, blink: false, sparkles: 0 },
  { bob: 3, wing: 0, leftWing: 0, blink: true, sparkles: 0 },
  { bob: 0, wing: -35, leftWing: 0, blink: false, sparkles: 0 },
  { bob: 0, wing: -80, leftWing: 0, blink: false, sparkles: 0 },
  { bob: 0, wing: -115, leftWing: 0, blink: false, sparkles: 0 },
  { bob: 0, wing: -80, leftWing: 0, blink: false, sparkles: 0 },
  { bob: -8, wing: -60, leftWing: 60, blink: false, sparkles: 1 },
  { bob: -26, wing: -110, leftWing: 110, blink: false, sparkles: 2 },
  { bob: -12, wing: -80, leftWing: 80, blink: false, sparkles: 3 },
  { bob: 0, wing: -30, leftWing: 30, blink: false, sparkles: 1 },
];

export const SWIFTEE_CLIPS = [
  { name: 'idle', from: 0, to: 1, fps: 2, loop: true },
  { name: 'wave', from: 2, to: 5, fps: 8, loop: false },
  { name: 'celebrate', from: 6, to: 9, fps: 8, loop: false },
];

/** Swiftee, the expedition's arctic bird guide (256×256 per frame). */
export function swifteeSvg(p: SwifteePose, size = 256): string {
  const eyes = p.blink
    ? `<path d="M-30 -30 h16 M14 -30 h16" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`
    : `<circle cx="-22" cy="-30" r="12" fill="#FFFFFF"/><circle cx="22" cy="-30" r="12" fill="#FFFFFF"/><circle cx="-19" cy="-29" r="6.5" fill="${INK}"/><circle cx="25" cy="-29" r="6.5" fill="${INK}"/><circle cx="-17" cy="-32" r="2" fill="#FFFFFF"/><circle cx="27" cy="-32" r="2" fill="#FFFFFF"/>`;
  const sparkle = (x: number, y: number, s: number) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0 -14 L4 -4 L14 0 L4 4 L0 14 L-4 4 L-14 0 L-4 -4 Z" fill="#FFD84D"/>`;
  const sparkles = [sparkle(-88, -70, 1), sparkle(92, -84, 0.8), sparkle(-70, 40, 0.7)].slice(0, p.sparkles).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <g transform="translate(128 ${148 + p.bob})">
    <ellipse cx="0" cy="${86 - p.bob}" rx="${60 + p.bob / 2}" ry="9" fill="#0F2740" opacity="0.18"/>
    <ellipse cx="-22" cy="80" rx="18" ry="7" fill="${ORANGE}"/><ellipse cx="22" cy="80" rx="18" ry="7" fill="${ORANGE}"/>
    <g transform="rotate(${p.leftWing} -58 -4)"><path d="M-58 -4 C-92 14 -94 56 -70 70 C-64 40 -62 18 -58 -4 Z" fill="${NAVY}"/></g>
    <ellipse cx="0" cy="10" rx="70" ry="76" fill="#1F3A5F"/>
    <ellipse cx="0" cy="28" rx="48" ry="54" fill="#FFFFFF"/>
    <g transform="rotate(${p.wing} 58 -4)"><path d="M58 -4 C92 14 94 56 70 70 C64 40 62 18 58 -4 Z" fill="${NAVY}"/></g>
    ${eyes}
    <path d="M-12 -14 L12 -14 L0 2 Z" fill="${ORANGE}"/>
    <circle cx="-40" cy="-10" r="8" fill="#F7A8B8" opacity="0.7"/><circle cx="40" cy="-10" r="8" fill="#F7A8B8" opacity="0.7"/>
    <path d="M-48 2 C-20 14 20 14 48 2 L46 16 C20 28 -20 28 -46 16 Z" fill="${ICE}"/>
    <path d="M30 18 l10 26 l-14 0 Z" fill="${ICE}"/>
    ${sparkles}
  </g>
</svg>`;
}

/** A blank frosted instruction panel — the game writes readable native text on top. */
export function panelSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="320" viewBox="0 0 1000 320">
  <defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.97"/><stop offset="1" stop-color="#E4F5FE" stop-opacity="0.95"/></linearGradient></defs>
  <rect x="8" y="8" width="984" height="304" rx="40" fill="url(#p)" stroke="#8FD3F4" stroke-width="6"/>
  <path d="M56 24 H944" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round" opacity="0.95"/>
  ${snowflake(40, 40, 18, 0.9).replace(/#FFFFFF/g, '#9FDCF7')}${snowflake(960, 280, 18, 0.9, 20).replace(/#FFFFFF/g, '#9FDCF7')}
</svg>`;
}

/** Text-free button artwork (the game puts the accessible label on top). */
export function buttonSvg(kind: 'primary' | 'secondary'): string {
  const [a, b, edge] = kind === 'primary' ? ['#4CC3F0', '#1F7FC4', '#145A8D'] : ['#FFFFFF', '#D8F0FC', '#7CC6EC'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="110" viewBox="0 0 360 110">
  <defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect x="5" y="9" width="350" height="96" rx="48" fill="${edge}"/>
  <rect x="5" y="5" width="350" height="92" rx="46" fill="url(#b)" stroke="${edge}" stroke-width="4"/>
  <path d="M40 24 H320" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" opacity="${kind === 'primary' ? 0.45 : 0.9}"/>
</svg>`;
}

/** Celebration sparkle: 6 frames of an expanding ring of snow sparkles (200×200 each). */
export function sparkleFrameSvg(i: number): string {
  const r = 20 + i * 14;
  const op = i < 4 ? 1 : 1 - (i - 3) * 0.3;
  const dots = Array.from({ length: 8 }, (_, k) => {
    const a = (k * 45 * Math.PI) / 180 + i * 0.12;
    const x = 100 + Math.cos(a) * r;
    const y = 100 + Math.sin(a) * r;
    return `<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${(0.5 + i * 0.12).toFixed(2)})" d="M0 -14 L4 -4 L14 0 L4 4 L0 14 L-4 4 L-14 0 L-4 -4 Z" fill="${k % 2 ? '#FFD84D' : '#7FD8FA'}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><g opacity="${op.toFixed(2)}">${dots}<circle cx="100" cy="100" r="${(8 + i * 3).toFixed(1)}" fill="none" stroke="#FFFFFF" stroke-width="3" opacity="${(0.9 - i * 0.12).toFixed(2)}"/></g></svg>`;
}

export type ShapeId = 'trapezium' | 'right-trapezium' | 'parallelogram' | 'kite' | 'irregular';

/** Shape cards with tick marks on parallel sides (360×260). */
export function shapeSvg(shape: ShapeId): string {
  const polys: Record<ShapeId, string> = {
    trapezium: '110,70 250,70 310,200 50,200',
    'right-trapezium': '70,70 230,70 300,200 70,200',
    parallelogram: '110,70 320,70 250,200 40,200',
    kite: '180,40 270,120 180,225 90,120',
    irregular: '70,90 260,55 310,210 110,190',
  };
  const arrows: Record<ShapeId, string> = {
    trapezium: '<path d="M172 64 l8 6 l-8 6 M172 194 l8 6 l-8 6"/>',
    'right-trapezium': '<path d="M142 64 l8 6 l-8 6 M177 194 l8 6 l-8 6"/>',
    parallelogram: '<path d="M207 64 l8 6 l-8 6 M137 194 l8 6 l-8 6 M282 132 l8 3 l-4 7 M70 132 l8 3 l-4 7"/>',
    kite: '',
    irregular: '',
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="260" viewBox="0 0 360 260">
  <rect x="4" y="4" width="352" height="252" rx="28" fill="#FFFFFF" stroke="#BFE6F8" stroke-width="4"/>
  <polygon points="${polys[shape]}" fill="#DDF3FD" stroke="${NAVY}" stroke-width="7" stroke-linejoin="round"/>
  <g fill="none" stroke="#D9480F" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${arrows[shape]}</g>
</svg>`;
}

/** A two-tone success chime (WAV, 16-bit mono) — uploaded sound for the motion sound tests. */
export function chimeWav(): Buffer {
  const rate = 22050;
  const seconds = 0.7;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = t < 0.18 ? 1046.5 : 1318.5;
    const local = t < 0.18 ? t : t - 0.18;
    const env = Math.exp(-local * 6) * Math.min(1, local * 200);
    const v = Math.sin(2 * Math.PI * f * t) * env * 0.45 + Math.sin(4 * Math.PI * f * t) * env * 0.08;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ───────────────────────────── exported design frames ─────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function bgInner(): string {
  return iceBackgroundSvg().replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

function embed(svg: string, x: number, y: number, w: number, h: number, stretch = false): string {
  const inner = svg.replace(/^<svg[^>]*viewBox="([^"]+)"[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? `0 0 ${w} ${h}`;
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${vb}"${stretch ? ' preserveAspectRatio="none"' : ''}>${inner}</svg>`;
}

function text(x: number, y: number, size: number, content: string, opts: { weight?: number; anchor?: string; fill?: string } = {}): string {
  return `<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${opts.weight ?? 700}" text-anchor="${opts.anchor ?? 'middle'}" fill="${opts.fill ?? INK}">${esc(content)}</text>`;
}

function frame(content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bgInner()}${content}</svg>`;
}

/** The designer's screens as flat exports (text and buttons are baked in, as real exports are). */
export const FRAME_SPECS = {
  intro: () =>
    frame(
      `${embed(panelSvg(), 460, 210, 1000, 320)}${text(960, 360, 96, 'Trapezium Quest')}${text(960, 440, 40, 'Grade 8 · Quadrilaterals', { weight: 600, fill: '#1F5F8B' })}` +
        `${embed(swifteeSvg(SWIFTEE_POSES[0]!), 1340, 560, 300, 300)}${embed(buttonSvg('primary'), 780, 640, 360, 110)}${text(960, 712, 44, 'Start', { fill: '#FFFFFF' })}`,
    ),
  spot: () =>
    frame(
      `${embed(panelSvg(), 120, 60, 1680, 230, true)}${text(960, 140, 56, 'Spot the parallel sides')}${text(960, 220, 34, 'A trapezium has exactly one pair of parallel sides. Drag each shape to the right group.', { weight: 500 })}` +
        `<rect x="160" y="330" width="1600" height="600" rx="36" fill="#FFFFFF" fill-opacity="0.35" stroke="#FFFFFF" stroke-width="6" stroke-dasharray="24 16"/>` +
        `${embed(swifteeSvg(SWIFTEE_POSES[0]!), 1640, 820, 220, 220)}${embed(buttonSvg('primary'), 1460, 950, 280, 86, true)}${text(1600, 1006, 36, 'Next', { fill: '#FFFFFF' })}`,
    ),
  spotHint: () =>
    frame(
      `${embed(panelSvg(), 120, 60, 1680, 230, true)}${text(960, 140, 56, 'Spot the parallel sides')}${text(960, 220, 34, 'A trapezium has exactly one pair of parallel sides. Drag each shape to the right group.', { weight: 500 })}` +
        `<rect x="160" y="330" width="1600" height="600" rx="36" fill="#FFFFFF" fill-opacity="0.35" stroke="#FFFFFF" stroke-width="6" stroke-dasharray="24 16"/>` +
        `<rect x="1160" y="700" width="460" height="120" rx="30" fill="#FFF8D6" stroke="#F2C94C" stroke-width="5"/>${text(1390, 772, 30, 'Look for sides that never meet.', { weight: 600 })}` +
        `${embed(swifteeSvg(SWIFTEE_POSES[3]!), 1640, 820, 220, 220)}`,
    ),
  match: () =>
    frame(
      `${embed(panelSvg(), 120, 60, 1680, 200, true)}${text(960, 150, 56, 'Match the shapes')}${text(960, 220, 34, 'Match each shape to its name.', { weight: 500 })}` +
        ['Trapezium', 'Parallelogram', 'Kite']
          .map((label, i) => `<rect x="${220 + i * 520}" y="640" width="440" height="260" rx="32" fill="#FFFFFF" fill-opacity="0.8" stroke="#7CC6EC" stroke-width="6"/>${text(440 + i * 520, 790, 44, label)}`)
          .join('') +
        `${embed(swifteeSvg(SWIFTEE_POSES[2]!), 1660, 330, 200, 200)}`,
    ),
  complete: () =>
    frame(
      `${embed(panelSvg(), 460, 200, 1000, 320)}${text(960, 360, 84, 'Expedition complete!')}${text(960, 440, 36, 'You can spot and name trapeziums.', { weight: 600, fill: '#1F5F8B' })}` +
        `${embed(swifteeSvg(SWIFTEE_POSES[7]!), 820, 540, 280, 280)}${embed(buttonSvg('primary'), 780, 860, 360, 110)}${text(960, 932, 44, 'Play again', { fill: '#FFFFFF' })}`,
    ),
} as const;
