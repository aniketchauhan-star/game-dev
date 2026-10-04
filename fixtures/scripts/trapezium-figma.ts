/**
 * Sample Figma data for “Trapezium Quest — Grade 8”: a Figma REST API file
 * document (the shape GET /v1/files/:key returns) describing the designer's
 * screens. Used by the mock Figma server in tests and the E2E scenario — it is
 * fixture data, not a live Figma file.
 *
 * It deliberately contains things the adapter must handle honestly: a font the
 * game does not ship (Baloo 2), a rotated vector, a gradient, a mask, mixed
 * text styles, a hidden layer, prototype links (incl. a URL action whose URL
 * must be dropped), and an instruction whose definition of a trapezium
 * (“exactly one pair”) conflicts with the lesson deck (“at least one pair”).
 */

export const FIGMA_FILE_KEY = 'TrapQuestDemo8x2026';
export const FIGMA_FILE_NAME = 'Trapezium Quest — Grade 8 (sample)';
export const FIGMA_VERSION = '4242424242';

type Color = { r: number; g: number; b: number; a: number };
const c = (hex: string, a = 1): Color => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a });

export interface FigmaJsonNode {
  id: string;
  name: string;
  type: string;
  [k: string]: unknown;
  children?: FigmaJsonNode[];
}

const solid = (hex: string, opacity = 1) => ({ blendMode: 'NORMAL', type: 'SOLID', color: c(hex), ...(opacity !== 1 ? { opacity } : {}) });
const image = (imageRef: string, scaleMode = 'FILL') => ({ blendMode: 'NORMAL', type: 'IMAGE', scaleMode, imageRef });

function box(fx: number, fy: number, x: number, y: number, w: number, h: number) {
  return { absoluteBoundingBox: { x: fx + x, y: fy + y, width: w, height: h }, absoluteRenderBounds: { x: fx + x, y: fy + y, width: w, height: h } };
}

function rect(fx: number, fy: number, id: string, name: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): FigmaJsonNode {
  return { id, name, type: 'RECTANGLE', blendMode: 'PASS_THROUGH', fills: [], strokes: [], strokeWeight: 1, effects: [], ...box(fx, fy, x, y, w, h), ...extra };
}

function text(fx: number, fy: number, id: string, name: string, x: number, y: number, w: number, h: number, characters: string, style: { size: number; weight?: number; family?: string; align?: string; color?: string }, extra: Record<string, unknown> = {}): FigmaJsonNode {
  return {
    id,
    name,
    type: 'TEXT',
    blendMode: 'PASS_THROUGH',
    characters,
    style: {
      fontFamily: style.family ?? 'Baloo 2',
      fontPostScriptName: null,
      fontWeight: style.weight ?? 700,
      fontSize: style.size,
      textAlignHorizontal: style.align ?? 'CENTER',
      textAlignVertical: 'CENTER',
      lineHeightPx: Math.round(style.size * 1.25),
    },
    characterStyleOverrides: [],
    styleOverrideTable: {},
    fills: [solid(style.color ?? '#0F2740')],
    strokes: [],
    effects: [],
    ...box(fx, fy, x, y, w, h),
    ...extra,
  };
}

function frameNode(id: string, name: string, fx: number, fy: number, children: FigmaJsonNode[], extra: Record<string, unknown> = {}): FigmaJsonNode {
  return {
    id,
    name,
    type: 'FRAME',
    blendMode: 'PASS_THROUGH',
    clipsContent: true,
    background: [solid('#D9F1FD')],
    fills: [solid('#D9F1FD')],
    backgroundColor: c('#D9F1FD'),
    strokes: [],
    effects: [],
    ...box(fx, fy, 0, 0, 1920, 1080),
    children,
    ...extra,
  };
}

const click = (destinationId: string, transition: { type: string; duration: number; direction?: string } | null) => ({
  trigger: { type: 'ON_CLICK' },
  actions: [{ type: 'NODE', destinationId, navigation: 'NAVIGATE', transition: transition ? { ...transition, easing: { type: 'EASE_OUT' } } : null, preserveScrollPosition: false }],
});

/** Positions of the frames on the canvas. */
const POS = { intro: [0, 0], spot: [2100, 0], spotHint: [4200, 0], match: [0, 1300], complete: [2100, 1300] } as const;

export function buildTrapeziumFigmaFile(): { name: string; lastModified: string; version: string; role: string; editorType: string; thumbnailUrl: string; schemaVersion: number; document: FigmaJsonNode; components: object; styles: object } {
  const [ix, iy] = POS.intro;
  const intro = frameNode('10:1', '01 Intro', ix, iy, [
    rect(ix, iy, '11:1', 'Ice background', 0, 0, 1920, 1080, { fills: [image('ref-ice-bg')] }),
    rect(ix, iy, '11:2', 'Title panel', 460, 210, 1000, 320, { fills: [solid('#FFFFFF', 0.94)], strokes: [solid('#8FD3F4')], strokeWeight: 6, cornerRadius: 40 }),
    text(ix, iy, '11:3', 'Title', 500, 300, 920, 110, 'Trapezium Quest', { size: 96 }),
    text(ix, iy, '11:4', 'Subtitle', 500, 405, 920, 60, 'Grade 8 · Quadrilaterals', { size: 40, weight: 600, color: '#1F5F8B' }),
    rect(ix, iy, '11:5', 'Swiftee', 1340, 560, 300, 300, { fills: [image('ref-swiftee')] }),
    {
      id: '11:6',
      name: 'Start button',
      type: 'INSTANCE',
      blendMode: 'PASS_THROUGH',
      fills: [],
      strokes: [],
      effects: [],
      ...box(ix, iy, 780, 640, 360, 110),
      interactions: [click('10:2', { type: 'DISSOLVE', duration: 0.3 })],
      children: [
        rect(ix, iy, '11:7', 'Button fill', 780, 640, 360, 110, { fills: [solid('#2A9AD8')], cornerRadius: 55 }),
        text(ix, iy, '11:8', 'Label', 780, 662, 360, 66, 'Start', { size: 44, color: '#FFFFFF' }),
      ],
    },
    {
      id: '11:9',
      name: 'Snowflake',
      type: 'VECTOR',
      blendMode: 'PASS_THROUGH',
      rotation: 0.26,
      fills: [solid('#FFFFFF')],
      strokes: [],
      effects: [],
      ...box(ix, iy, 140, 120, 64, 64),
    },
    rect(ix, iy, '11:10', 'Old title (hidden)', 500, 160, 920, 40, { visible: false, fills: [solid('#FF0000')] }),
  ]);

  const spotChildren = (fx: number, fy: number, prefix: string, hint: boolean): FigmaJsonNode[] => [
    rect(fx, fy, `${prefix}:1`, 'Ice background', 0, 0, 1920, 1080, { fills: [image('ref-ice-bg')] }),
    rect(fx, fy, `${prefix}:2`, 'Instruction panel', 120, 60, 1680, 230, { fills: [solid('#FFFFFF', 0.94)], strokes: [solid('#8FD3F4')], strokeWeight: 6, cornerRadius: 40 }),
    text(fx, fy, `${prefix}:3`, 'Screen title', 160, 95, 1600, 80, 'Spot the parallel sides', { size: 56 }),
    text(fx, fy, `${prefix}:4`, 'Instruction', 160, 180, 1600, 80, 'A trapezium has exactly one pair of parallel sides. Drag each shape to the right group.', { size: 34, weight: 500 }),
    rect(fx, fy, `${prefix}:5`, 'Play area', 160, 330, 1600, 600, { fills: [solid('#FFFFFF', 0.35)], strokes: [solid('#FFFFFF')], strokeWeight: 6, cornerRadius: 36 }),
    rect(fx, fy, `${prefix}:6`, 'Swiftee', 1640, 820, 220, 220, { fills: [image('ref-swiftee')] }),
    rect(fx, fy, `${prefix}:7`, 'Frosty glow', 0, 0, 1920, 120, { fills: [{ blendMode: 'NORMAL', type: 'GRADIENT_LINEAR', gradientStops: [{ position: 0, color: c('#FFFFFF', 0.6) }, { position: 1, color: c('#FFFFFF', 0) }], gradientHandlePositions: [] }] }),
    {
      id: `${prefix}:8`,
      name: 'Masked sparkle',
      type: 'GROUP',
      blendMode: 'PASS_THROUGH',
      fills: [],
      strokes: [],
      effects: [],
      ...box(fx, fy, 60, 940, 120, 120),
      children: [
        { id: `${prefix}:9`, name: 'Mask', type: 'ELLIPSE', isMask: true, blendMode: 'PASS_THROUGH', fills: [solid('#FFFFFF')], strokes: [], effects: [], ...box(fx, fy, 60, 940, 120, 120) },
        { id: `${prefix}:10`, name: 'Sparkle art', type: 'STAR', blendMode: 'PASS_THROUGH', fills: [solid('#FFD84D')], strokes: [], effects: [], ...box(fx, fy, 70, 950, 100, 100) },
      ],
    },
    hint
      ? text(fx, fy, `${prefix}:11`, 'Hint bubble text', 1160, 700, 460, 120, 'Look for sides that never meet.', { size: 30, weight: 600 }, {
          characterStyleOverrides: [1, 1, 1, 1, 0, 0, 0],
          styleOverrideTable: { 1: { fontWeight: 800 } },
        })
      : {
          id: `${prefix}:11`,
          name: 'Next button',
          type: 'INSTANCE',
          blendMode: 'PASS_THROUGH',
          fills: [],
          strokes: [],
          effects: [{ type: 'DROP_SHADOW', visible: true, radius: 8, color: c('#0F2740', 0.3), offset: { x: 0, y: 4 } }],
          ...box(fx, fy, 1460, 950, 280, 86),
          interactions: [click('10:4', { type: 'SMART_ANIMATE', duration: 0.4 }), { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'URL', url: 'https://example.com/ignore-this-link', openInNewTab: true }] }],
          children: [rect(fx, fy, `${prefix}:12`, 'Button fill', 1460, 950, 280, 86, { fills: [solid('#2A9AD8')], cornerRadius: 43 }), text(fx, fy, `${prefix}:13`, 'Label', 1460, 968, 280, 50, 'Next', { size: 36, color: '#FFFFFF' })],
        },
  ];
  const [sx, sy] = POS.spot;
  const spot = frameNode('10:2', '02 Spot the parallel sides', sx, sy, spotChildren(sx, sy, '12', false));
  const [hx, hy] = POS.spotHint;
  const spotHint = frameNode('10:3', '02b Spot the parallel sides — hint state', hx, hy, spotChildren(hx, hy, '13', true));

  const [mx, my] = POS.match;
  const match = frameNode('10:4', '03 Match the shapes', mx, my, [
    rect(mx, my, '14:1', 'Ice background', 0, 0, 1920, 1080, { fills: [image('ref-ice-bg')] }),
    rect(mx, my, '14:2', 'Instruction panel', 120, 60, 1680, 200, { fills: [solid('#FFFFFF', 0.94)], strokes: [solid('#8FD3F4')], strokeWeight: 6, cornerRadius: 40 }),
    text(mx, my, '14:3', 'Screen title', 160, 100, 1600, 80, 'Match the shapes', { size: 56 }),
    text(mx, my, '14:4', 'Instruction', 160, 185, 1600, 60, 'Match each shape to its name.', { size: 34, weight: 500 }),
    rect(mx, my, '14:5', 'Play area', 160, 300, 1600, 680, { fills: [solid('#FFFFFF', 0.25)], cornerRadius: 36 }),
    ...['Trapezium', 'Parallelogram', 'Kite'].flatMap((label, i) => [
      rect(mx, my, `14:${10 + i * 2}`, `Target ${label}`, 220 + i * 520, 640, 440, 260, { fills: [solid('#FFFFFF', 0.8)], strokes: [solid('#7CC6EC')], strokeWeight: 6, cornerRadius: 32 }),
      text(mx, my, `14:${11 + i * 2}`, `Target label ${label}`, 220 + i * 520, 740, 440, 60, label, { size: 44 }),
    ]),
    rect(mx, my, '14:20', 'Swiftee', 1660, 330, 200, 200, { fills: [image('ref-swiftee')] }),
  ]);

  const [cx, cy] = POS.complete;
  const complete = frameNode('10:5', '04 Well done', cx, cy, [
    rect(cx, cy, '15:1', 'Ice background', 0, 0, 1920, 1080, { fills: [image('ref-ice-bg')] }),
    rect(cx, cy, '15:2', 'Panel', 460, 200, 1000, 320, { fills: [solid('#FFFFFF', 0.94)], strokes: [solid('#8FD3F4')], strokeWeight: 6, cornerRadius: 40 }),
    text(cx, cy, '15:3', 'Heading', 500, 300, 920, 100, 'Expedition complete!', { size: 84 }),
    text(cx, cy, '15:4', 'Message', 500, 410, 920, 50, 'You can spot and name trapeziums.', { size: 36, weight: 600, color: '#1F5F8B' }),
    rect(cx, cy, '15:5', 'Swiftee', 820, 540, 280, 280, { fills: [image('ref-swiftee')] }),
    rect(cx, cy, '15:6', 'Play again button', 780, 860, 360, 110, { fills: [solid('#2A9AD8')], cornerRadius: 55, interactions: [click('10:1', { type: 'MOVE_IN', duration: 0.3, direction: 'LEFT' })] }),
    text(cx, cy, '15:7', 'Play again label', 780, 882, 360, 66, 'Play again', { size: 44, color: '#FFFFFF' }),
  ]);

  const components: FigmaJsonNode = {
    id: '0:2',
    name: 'Components',
    type: 'CANVAS',
    backgroundColor: c('#F5F5F5'),
    children: [
      {
        id: '20:1',
        name: 'Button / Primary',
        type: 'COMPONENT',
        blendMode: 'PASS_THROUGH',
        fills: [solid('#2A9AD8')],
        strokes: [],
        effects: [],
        cornerRadius: 55,
        ...box(0, 3000, 0, 0, 360, 110),
        children: [text(0, 3000, '20:2', 'Label', 0, 22, 360, 66, 'Button', { size: 44, color: '#FFFFFF' })],
      },
    ],
  };

  return {
    name: FIGMA_FILE_NAME,
    lastModified: '2026-09-28T09:30:00Z',
    version: FIGMA_VERSION,
    role: 'viewer',
    editorType: 'figma',
    thumbnailUrl: '',
    schemaVersion: 0,
    document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{ id: '0:1', name: 'Game screens', type: 'CANVAS', backgroundColor: c('#E5E5E5'), children: [intro, spot, spotHint, match, complete] }, components] },
    components: {},
    styles: {},
  };
}

/** Which exported frame file renders each node, and which art file each image fill uses. */
export const FIGMA_RENDERS: Record<string, string> = {
  '10:1': 'frames/01-intro.png',
  '10:2': 'frames/02-spot.png',
  '10:3': 'frames/02b-spot-hint.png',
  '10:4': 'frames/03-match.png',
  '10:5': 'frames/04-complete.png',
  '20:1': 'art/button-primary.png',
};

export const FIGMA_FILLS: Record<string, string> = {
  'ref-ice-bg': 'art/ice-background.png',
  'ref-swiftee': 'art/swiftee-01.png',
};
