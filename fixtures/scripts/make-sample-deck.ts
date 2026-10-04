import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSampleDeck } from './sample-deck.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'sample', 'air-traffic-control.pptx');

const buf = await buildSampleDeck();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);
console.log(`Wrote ${path.relative(process.cwd(), out)} (${buf.length} bytes)`);
