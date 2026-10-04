import sharp from 'sharp';
import { buildPptx, type SlideSpec } from './pptx-builder.ts';

/**
 * Bundled sample: “Air Traffic Control — Coordinate Mission”. This is example
 * content shipped with NEXUS Play Studio, never presented as a user upload.
 * Part numbers deliberately differ from presentation order (slide10.xml is the
 * 4th slide) to exercise presentation.xml ordering.
 */

export const SAMPLE_ORDER = [1, 2, 3, 10, 4, 5, 6, 7, 8];
/** p:sldId values written by the builder (256 + part number). */
export const sampleSlideId = (part: number) => 256 + part;

function gridSvg(): string {
  const w = 900, h = 700, unit = 60, ox = 450, oy = 350;
  let lines = '';
  for (let i = -7; i <= 7; i++) lines += `<line x1="${ox + i * unit}" y1="20" x2="${ox + i * unit}" y2="${h - 20}" stroke="#C9D8E8" stroke-width="2"/>`;
  for (let j = -5; j <= 5; j++) lines += `<line x1="20" y1="${oy - j * unit}" x2="${w - 20}" y2="${oy - j * unit}" stroke="#C9D8E8" stroke-width="2"/>`;
  let labels = '';
  for (let i = -6; i <= 6; i += 2) if (i !== 0) labels += `<text x="${ox + i * unit}" y="${oy + 30}" font-size="22" text-anchor="middle" fill="#1E3A55" font-family="Arial">${i < 0 ? '−' + -i : i}</text>`;
  for (let j = -4; j <= 4; j += 2) if (j !== 0) labels += `<text x="${ox - 14}" y="${oy - j * unit + 8}" font-size="22" text-anchor="end" fill="#1E3A55" font-family="Arial">${j < 0 ? '−' + -j : j}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#FFFFFF"/>${lines}
    <line x1="20" y1="${oy}" x2="${w - 20}" y2="${oy}" stroke="#1E3A55" stroke-width="5"/>
    <line x1="${ox}" y1="20" x2="${ox}" y2="${h - 20}" stroke="#1E3A55" stroke-width="5"/>
    <text x="${w - 30}" y="${oy - 14}" font-size="30" font-weight="bold" fill="#1E3A55" font-family="Arial">x</text>
    <text x="${ox + 14}" y="44" font-size="30" font-weight="bold" fill="#1E3A55" font-family="Arial">y</text>
    <circle cx="${ox}" cy="${oy}" r="9" fill="#D9480F"/>
    <text x="${ox + 14}" y="${oy + 32}" font-size="22" fill="#D9480F" font-family="Arial">(0, 0)</text>
    <circle cx="${ox + 3 * unit}" cy="${oy - 2 * unit}" r="11" fill="#1F5FAD"/>
    <text x="${ox + 3 * unit + 16}" y="${oy - 2 * unit - 12}" font-size="22" fill="#1F5FAD" font-family="Arial">(3, 2)</text>
    ${labels}
  </svg>`;
}

export function aircraftSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
    <g transform="translate(160 160)">
      <path d="M0 -140 C14 -140 20 -118 20 -96 L20 -30 L140 30 L140 56 L20 26 L20 92 L56 120 L56 138 L0 124 L-56 138 L-56 120 L-20 92 L-20 26 L-140 56 L-140 30 L-20 -30 L-20 -96 C-20 -118 -14 -140 0 -140 Z" fill="#F5F7FA" stroke="#1F3A5F" stroke-width="8" stroke-linejoin="round"/>
      <path d="M-12 -100 L12 -100 L10 -78 L-10 -78 Z" fill="#1F5FAD"/>
      <rect x="-128" y="34" width="44" height="12" rx="4" fill="#D9480F"/>
      <rect x="84" y="34" width="44" height="12" rx="4" fill="#D9480F"/>
      <circle cx="0" cy="-20" r="10" fill="#1F5FAD"/>
    </g>
  </svg>`;
}

function airfieldSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
    <rect width="1600" height="900" fill="#9CC98A"/>
    <rect x="0" y="0" width="1600" height="900" fill="url(#g)" opacity="0.35"/>
    <defs><pattern id="g" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M80 0 L0 0 0 80" fill="none" stroke="#7FB06E" stroke-width="2"/></pattern></defs>
    <rect x="120" y="390" width="1360" height="120" rx="8" fill="#5B6670"/>
    <g fill="#FFFFFF">${Array.from({ length: 16 }, (_, i) => `<rect x="${170 + i * 82}" y="444" width="50" height="12" rx="3"/>`).join('')}</g>
    <rect x="740" y="80" width="120" height="740" rx="8" fill="#6B7680"/>
    <g fill="#FFFFFF">${Array.from({ length: 8 }, (_, i) => `<rect x="794" y="${120 + i * 86}" width="12" height="44" rx="3"/>`).join('')}</g>
    <rect x="1180" y="140" width="220" height="150" rx="10" fill="#C8CED6"/>
    <rect x="1380" y="620" width="70" height="170" rx="6" fill="#E3E7EC"/>
    <circle cx="1415" cy="610" r="44" fill="#1F5FAD"/>
    <circle cx="1415" cy="610" r="30" fill="#BFD7F2"/>
    <text x="1300" y="840" font-size="40" font-family="Arial" font-weight="bold" fill="#1F3A5F">TOWER</text>
    <text x="180" y="370" font-size="40" font-family="Arial" font-weight="bold" fill="#1F3A5F">RUNWAY 09</text>
  </svg>`;
}

async function png(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

const DIST_OMML =
  '<m:r><m:t>d=</m:t></m:r><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>' +
  '<m:sSup><m:e><m:d><m:dPr/><m:e><m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>2</m:t></m:r></m:sub></m:sSub><m:r><m:t>−</m:t></m:r><m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>1</m:t></m:r></m:sub></m:sSub></m:e></m:d></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>' +
  '<m:r><m:t>+</m:t></m:r>' +
  '<m:sSup><m:e><m:d><m:dPr/><m:e><m:sSub><m:e><m:r><m:t>y</m:t></m:r></m:e><m:sub><m:r><m:t>2</m:t></m:r></m:sub></m:sSub><m:r><m:t>−</m:t></m:r><m:sSub><m:e><m:r><m:t>y</m:t></m:r></m:e><m:sub><m:r><m:t>1</m:t></m:r></m:sub></m:sSub></m:e></m:d></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>' +
  '</m:e></m:rad>';

export async function buildSampleDeck(): Promise<Buffer> {
  const [grid, aircraft, airfield] = await Promise.all([png(gridSvg()), png(aircraftSvg()), png(airfieldSvg())]);
  const slides: SlideSpec[] = [
    {
      partNumber: 1,
      layout: 'title',
      title: 'Air Traffic Control: Coordinate Mission',
      subtitle: 'Grade 9 Mathematics · The coordinate plane',
      notes: ['Hook: ask how air traffic controllers say exactly where an aircraft is.', 'Today learners guide aircraft using ordered pairs.'],
    },
    {
      partNumber: 2,
      layout: 'content',
      title: 'The airfield is a coordinate plane',
      bullets: ['The x-axis runs left to right.', 'The y-axis runs bottom to top.', 'The axes cross at the origin, (0, 0).', 'Grid lines are equally spaced on both axes.'],
      image: { file: 'coordinate-grid.png', png: grid, alt: 'Coordinate grid with x- and y-axes crossing at the origin and the point (3, 2) marked', x: 6400800, y: 1825625, w: 4953000, h: 3852333 },
      notes: ['Draw both axes on the board. Stress equal spacing on both axes.'],
    },
    {
      partNumber: 3,
      layout: 'content',
      title: 'Reading an ordered pair (x, y)',
      bullets: ['x: move right (+) or left (−) from the origin.', 'y: move up (+) or down (−).', 'Always move along x first, then y.', { text: 'Example: (3, 2) means 3 right, then 2 up.', level: 1 }],
      animate: true,
      notes: ['Common mistake: swapping x and y.', 'Ask learners to say each move aloud before they move.'],
    },
    {
      partNumber: 10,
      layout: 'content',
      title: 'The four quadrants',
      bullets: ['The axes split the plane into four quadrants.', 'Points on an axis are not in any quadrant.'],
      table: [
        ['Quadrant', 'x', 'y'],
        ['I', '+', '+'],
        ['II', '−', '+'],
        ['III', '−', '−'],
        ['IV', '+', '−'],
      ],
      notes: ['Quadrants are numbered counter-clockwise, starting at the top right.'],
    },
    {
      partNumber: 4,
      layout: 'content',
      title: 'Negative coordinates',
      bullets: ['(−4, −3) means 4 left, then 3 down.', 'The sign gives the direction; the number gives the distance.', '(−4, −3) is in Quadrant III.'],
      notes: ['Contrast (−4, −3) with (4, 3) on the grid.'],
    },
    {
      partNumber: 5,
      layout: 'content',
      hidden: true,
      title: 'Teacher answer key',
      bullets: ['Runway Alpha: (3, 2)', 'Hangar: (−4, −3)', 'Practice target: (3, −2)'],
      notes: ['Hidden slide — not shown to learners.'],
    },
    {
      partNumber: 6,
      layout: 'content',
      title: 'Tower to runway: plotting steps',
      bullets: ['1. Start at the origin.', '2. Move along the x-axis.', '3. Move parallel to the y-axis.', '4. Confirm the position with the tower.'],
      image: { file: 'aircraft.png', png: aircraft, alt: 'Top view of a passenger aircraft (transparent background)', x: 8382000, y: 3657600, w: 1828800, h: 1828800 },
      group: [
        { text: 'TOWER', x: 7010400, y: 1828800, w: 1828800, h: 609600 },
        { text: 'RUNWAY', x: 9144000, y: 1828800, w: 1828800, h: 609600 },
      ],
      notes: ['Model each step with flight NX7 before learners try.'],
    },
    {
      partNumber: 7,
      layout: 'content',
      title: 'Extension: distance between two aircraft',
      bullets: ['Optional for fast finishers.'],
      equation: { omml: DIST_OMML, fallback: 'd = √((x₂ − x₁)² + (y₂ − y₁)²)' },
      notes: ['Extension only; not required for the mission.'],
    },
    {
      partNumber: 8,
      layout: 'content',
      title: 'Mission practice',
      bullets: ['Guide flight NX7 to runway (3, −2).', 'Park a plane anywhere in Quadrant II.', 'Line up aircraft by x-coordinate, left to right.'],
      image: { file: 'airfield-map.png', png: airfield, alt: 'Top-down airfield map with two runways and a control tower', x: 6400800, y: 1825625, w: 4953000, h: 2786063 },
      notes: ['Use the game to practise; discuss errors as a class.'],
    },
  ];
  return buildPptx({ slides, order: SAMPLE_ORDER, title: 'Air Traffic Control — Coordinate Mission' });
}
