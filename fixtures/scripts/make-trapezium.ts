import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildPptx, type SlideSpec } from './pptx-builder.ts';
import { buttonSvg, chimeWav, FRAME_SPECS, iceBackgroundSvg, panelSvg, shapeSvg, sparkleFrameSvg, SWIFTEE_POSES, swifteeSvg, type ShapeId } from './trapezium-art.ts';
import { buildTrapeziumFigmaFile, FIGMA_FILLS, FIGMA_RENDERS } from './trapezium-figma.ts';

/**
 * Writes the bundled Grade 8 sample “Trapezium Quest” into fixtures/trapezium:
 *   trapezium-lesson.pptx   labelled sample lesson (real OOXML, goes through the real importer)
 *   frames/*.png            the designer's screens as flat exports (1920×1080)
 *   art/*                   exact artwork: ice background, Swiftee frames + sheet,
 *                           blank panel, buttons, celebration sparkle, shape cards, chime
 *   figma/file.json         sample Figma REST data for the mock Figma server
 *
 * Run: npm run fixtures:trapezium
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'trapezium');

const png = (svg: string) => sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

async function write(rel: string, data: Buffer | string): Promise<void> {
  const file = path.join(out, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

export async function buildTrapeziumDeck(): Promise<Buffer> {
  const [trap, para, kite] = await Promise.all([png(shapeSvg('trapezium')), png(shapeSvg('parallelogram')), png(shapeSvg('kite'))]);
  const slides: SlideSpec[] = [
    {
      partNumber: 1,
      layout: 'title',
      title: 'Trapezium Quest',
      subtitle: 'Grade 8 Mathematics · Quadrilaterals (sample lesson)',
      notes: ['Sample lesson bundled with NEXUS Play Studio.', 'Hook: Swiftee the arctic bird needs help sorting ice floes by shape.'],
    },
    {
      partNumber: 2,
      layout: 'content',
      title: 'What is a trapezium?',
      bullets: [
        'A trapezium is a quadrilateral with at least one pair of parallel sides.',
        'The parallel sides are called the bases.',
        'The other two sides are called the legs.',
        'With this definition, every parallelogram is also a trapezium.',
      ],
      image: { file: 'trapezium.png', png: trap, alt: 'A trapezium with arrow marks on its two parallel bases', x: 7315200, y: 1828800, w: 3657600, h: 2641600 },
      notes: ['We use the inclusive definition (at least one pair), as in our textbook.', 'Some books use “exactly one pair” — mention it, but keep our definition.'],
    },
    {
      partNumber: 3,
      layout: 'content',
      title: 'Spot the parallel sides',
      bullets: ['Parallel sides never meet, however far they are extended.', 'Arrow marks on a diagram show which sides are parallel.', 'Check each shape: does it have at least one pair of parallel sides?'],
      image: { file: 'parallelogram.png', png: para, alt: 'A parallelogram with arrow marks showing two pairs of parallel sides', x: 7315200, y: 1828800, w: 3657600, h: 2641600 },
      notes: ['Guided identification: model one shape, then let learners try.', 'Common mistake: thinking a kite has parallel sides.'],
    },
    {
      partNumber: 4,
      layout: 'content',
      title: 'Trapezium or not?',
      bullets: ['Count the pairs of parallel sides.'],
      table: [
        ['Shape', 'Pairs of parallel sides', 'Trapezium?'],
        ['Trapezium', '1', 'Yes'],
        ['Right trapezium', '1', 'Yes'],
        ['Parallelogram', '2', 'Yes'],
        ['Kite', '0', 'No'],
      ],
      notes: ['Answer rule: a shape is a trapezium if it has at least one pair of parallel sides.'],
    },
    {
      partNumber: 5,
      layout: 'content',
      title: 'Match the shapes',
      bullets: ['Match each shape to its name: trapezium, parallelogram, kite.', 'Use the parallel sides to decide.'],
      image: { file: 'kite.png', png: kite, alt: 'A kite with no parallel sides', x: 7315200, y: 1828800, w: 3657600, h: 2641600 },
      notes: ['Matching practice for the game.'],
    },
    {
      partNumber: 6,
      layout: 'content',
      hidden: true,
      title: 'Teacher answer key',
      bullets: ['Trapezium → trapezium', 'Parallelogram → parallelogram (also a trapezium)', 'Kite → kite (not a trapezium)'],
      notes: ['Hidden slide — not shown to learners.'],
    },
    {
      partNumber: 7,
      layout: 'content',
      title: 'Expedition complete',
      bullets: ['A trapezium has at least one pair of parallel sides.', 'You can spot parallel sides and name trapeziums, parallelograms and kites.'],
      notes: ['Exit ticket: draw a trapezium that is not a parallelogram.'],
    },
  ];
  return buildPptx({ slides, title: 'Trapezium Quest — Grade 8 (sample)' });
}

async function main(): Promise<void> {
  await write('trapezium-lesson.pptx', await buildTrapeziumDeck());

  // Exact artwork.
  await write('art/ice-background.png', await png(iceBackgroundSvg()));
  await write('art/panel-blank.png', await png(panelSvg()));
  await write('art/button-primary.png', await png(buttonSvg('primary')));
  await write('art/button-secondary.png', await png(buttonSvg('secondary')));
  const frames = await Promise.all(SWIFTEE_POSES.map((p) => png(swifteeSvg(p))));
  for (const [i, f] of frames.entries()) await write(`art/swiftee-${String(i + 1).padStart(2, '0')}.png`, f);
  // The same frames as one 5×2 sprite sheet (256×256 cells).
  const sheet = await sharp({ create: { width: 1280, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(frames.map((input, i) => ({ input, left: (i % 5) * 256, top: Math.floor(i / 5) * 256 })))
    .png({ compressionLevel: 9 })
    .toBuffer();
  await write('art/swiftee-sheet.png', sheet);
  const sparkles = await Promise.all(Array.from({ length: 6 }, (_, i) => png(sparkleFrameSvg(i))));
  const sparkleSheet = await sharp({ create: { width: 1200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(sparkles.map((input, i) => ({ input, left: i * 200, top: 0 })))
    .png({ compressionLevel: 9 })
    .toBuffer();
  await write('art/celebration-sparkle.png', sparkleSheet);
  for (const s of ['trapezium', 'right-trapezium', 'parallelogram', 'kite', 'irregular'] as ShapeId[]) await write(`art/shape-${s}.png`, await png(shapeSvg(s)));
  await write('art/chime.wav', chimeWav());

  // The designer's screens as flat exports.
  await write('frames/01-intro.png', await png(FRAME_SPECS.intro()));
  await write('frames/02-spot.png', await png(FRAME_SPECS.spot()));
  await write('frames/02b-spot-hint.png', await png(FRAME_SPECS.spotHint()));
  await write('frames/03-match.png', await png(FRAME_SPECS.match()));
  await write('frames/04-complete.png', await png(FRAME_SPECS.complete()));

  // Sample Figma data (for the mock Figma server).
  await write('figma/file.json', `${JSON.stringify(buildTrapeziumFigmaFile(), null, 1)}\n`);
  await write('figma/assets.json', `${JSON.stringify({ renders: FIGMA_RENDERS, fills: FIGMA_FILLS }, null, 2)}\n`);
  await write(
    'README.md',
    [
      '# Trapezium Quest — bundled Grade 8 sample',
      '',
      'Sample content shipped with NEXUS Play Studio (generated by `fixtures/scripts/make-trapezium.ts`). It is labelled as a sample everywhere it appears.',
      '',
      '- `trapezium-lesson.pptx` — the lesson deck (definition: *at least one* pair of parallel sides).',
      '- `frames/` — the designer’s screens as flat PNG exports. Their instruction text says *exactly one* pair, which conflicts with the deck on purpose: the studio must flag it, not silently pick one.',
      '- `art/` — exact artwork: ice background, Swiftee frames (`swiftee-01…10.png`) and the same frames as `swiftee-sheet.png` (5×2, 256 px; clips idle 1–2, wave 3–6, celebrate 7–10), blank panel, text-free buttons, a celebration sparkle sheet (6×200 px), shape cards and a chime.',
      '- `figma/file.json` — sample Figma REST data used by the mock Figma server in tests. It is not a live Figma file.',
      '',
    ].join('\n'),
  );
  console.log(`Wrote the trapezium sample into ${path.relative(process.cwd(), out)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
