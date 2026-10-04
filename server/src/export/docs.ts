import type { Blueprint } from '@shared/schemas/blueprint.ts';
import type { GameBrief } from '@shared/schemas/brief.ts';
import type { GameConfig } from '@shared/schemas/game.ts';
import type { Preflight } from '@shared/schemas/exports.ts';
import type { Asset } from '@shared/schemas/assets.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { describeCoordinateRule, describeMatchRule, describeSequenceRule } from '@shared/rules.ts';
import { MECHANICS, SCENE_TYPES } from '@shared/registry.ts';

/** Generated documentation for the source package and the Claude Code handoff. */

const slideLabel = (slides: Map<string, SourceSlide>, ids: string[]) =>
  ids.length ? ids.map((id) => (slides.has(id) ? `slide ${slides.get(id)!.slideNumber}` : id)).join(', ') : 'added practice';

export function ruleSummary(scene: Blueprint['scenes'][number] | GameConfig['scenes'][number]): string {
  const i = scene.interaction;
  switch (i.type) {
    case 'coordinate-navigation':
      return describeCoordinateRule(i.rule);
    case 'drag-match':
      return describeMatchRule(i);
    case 'sequence-sort':
      return describeSequenceRule(i.rule);
    case 'info':
      return 'Continue after reading';
    case 'custom':
      return 'Custom mechanic — not built (blueprint only)';
  }
}

export function preflightMarkdown(p: Preflight): string {
  const icon = { pass: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' } as const;
  return `# Export preflight — ${p.label}

Version: ${p.versionNumber !== null ? `v${p.versionNumber}` : 'no playable version'}${p.blueprintRevisionNumber !== null ? ` (from blueprint r${p.blueprintRevisionNumber})` : ''}

| Check | Result | Detail |
| --- | --- | --- |
${p.checks.map((c) => `| ${c.label} | ${icon[c.status]} ${c.status} | ${c.detail.replace(/\|/g, '\\|')} |`).join('\n')}

## Checks that actually ran during this export
${p.testsRun.map((t) => `- ${t}`).join('\n')}

Browser playtesting is **not** part of this export. Play the game in a browser before sharing it.
${p.missingAssets.length ? `\n## Missing assets\n${p.missingAssets.map((a) => `- ${a}`).join('\n')}\n` : ''}${p.unresolvedSourceWarnings.length ? `\n## Unresolved source warnings\n${p.unresolvedSourceWarnings.map((a) => `- ${a}`).join('\n')}\n` : ''}${p.unsupportedScenes.length ? `\n## Unsupported (blueprint-only) scenes\n${p.unsupportedScenes.map((a) => `- ${a}`).join('\n')}\n` : ''}`;
}

export function playableReadme(title: string, versionNumber: number): string {
  return `${title} — playable game (version ${versionNumber})
Exported from NEXUS Play Studio.

HOW TO PLAY LOCALLY
  This is a static website. Serve this folder with any static web server and open index.html, for example:
    npx serve .            (Node.js)
    python3 -m http.server (Python)
  It also works from a sub-folder of an existing website (all paths are relative).

HOSTING
  Upload the whole folder to any static host (school LMS file area, GitHub Pages, Netlify, S3…).
  No server code, learner login or AI service is needed — gameplay never calls Claude.

CONTENTS
  index.html        entry point
  game.config.js    the game (generated from game.config.json in the source package)
  runtime/          the NEXUS game runtime (HTML/CSS/JS/SVG, no external dependencies)
  assets/           images and audio used by the game
  PREFLIGHT.md      checks that ran when this export was created
`;
}

export function sourceReadme(title: string, versionNumber: number | null): string {
  return `# ${title} — source package

Exported from NEXUS Play Studio${versionNumber !== null ? ` (game version ${versionNumber})` : ''}.

## What is here

| Path | Purpose |
| --- | --- |
| \`game.config.json\` | The whole game as data: scenes, rules, feedback, theme. Edit this. |
| \`asset-map.json\` | Which asset file is used where, with crop/scale/anchor metadata. |
| \`assets/\` | Asset files used by the game. \`assets/originals/\` keeps the original uploads. |
| \`runtime/\` | The prebuilt NEXUS runtime (plain JavaScript and CSS). |
| \`runtime-src/\` | TypeScript source of the runtime and the shared rule engine. |
| \`index.html\` | Page template. |
| \`build.mjs\` | Validates \`game.config.json\` and writes a playable site to \`dist/\`. |
| \`serve.mjs\` | Serves \`dist/\` on http://127.0.0.1:8080 for testing. |

## Build

Requires Node.js 18 or later. No dependencies are installed.

\`\`\`sh
node build.mjs     # writes dist/
node serve.mjs     # open http://127.0.0.1:8080
\`\`\`

Answer rules are data (for example \`{"kind":"point-equals","target":{"x":3,"y":2}}\`) and are evaluated by
trusted code in the runtime — never write formulas or code into the configuration.

## Not included

API keys, environment files, studio conversations, the original slide deck and speaker notes are never part of
this package${''} unless “Include source material” was selected (then see \`source-material/\`).
`;
}

export function developerHandoffReadme(title: string, blueprintNumber: number | null): string {
  return `# ${title} — developer handoff

Exported from NEXUS Play Studio${blueprintNumber !== null ? ` (approved blueprint r${blueprintNumber})` : ''}.

The game idea uses an interaction that NEXUS cannot build in the app yet, so this package contains the
approved design — **not** a playable game. A developer implements the new interaction, then the game can be
built like any other NEXUS game.

## What is here

| Path | Purpose |
| --- | --- |
| \`GAME_DESIGN.md\` | Design intent, learning outcomes, scene flow, rules and feedback. Start here. |
| \`TASKS.md\` | The custom mechanic to build, requested changes and open questions. |
| \`blueprint.json\` | The approved blueprint as data (scenes, source slides, locks, asset needs). |
| \`source-map.json\` | Which slides each scene comes from (no speaker notes). |
| \`ASSET_GUIDE.md\`, \`asset-map.json\` | Asset roles, supplied files and missing items. |
| \`runtime-src/\` | TypeScript source of the NEXUS runtime and its rule engine — the reference for adding a scene type. |
| \`CLAUDE.md\` | Ground rules for working on this package with Claude Code. |

## Adding the new interaction

Follow the pattern of the existing scene types (coordinate navigation, drag-and-match, sequence sorting):

1. Describe it as data in \`runtime-src/shared/schemas/interaction.ts\` (a new \`type\` with a Zod schema).
2. Add an allowlisted rule evaluator in \`runtime-src/shared/rules.ts\` and an attainability check in
   \`runtime-src/shared/attainability.ts\` — rules are data, never formulas or code.
3. Register it in \`runtime-src/shared/registry.ts\` and render it in \`runtime-src/runtime/scenes/\`, with keyboard
   play, a non-drag alternative, text + icon feedback, and reduced-motion support.

## Not included

API keys, environment files, studio conversations, the original slide deck and speaker notes are never part of
this package unless “Include source material” was selected (then see \`source-material/\`).
`;
}

export const BUILD_MJS = `// Builds a static, playable site from game.config.json into dist/. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const config = JSON.parse(fs.readFileSync(path.join(root, 'game.config.json'), 'utf8'));

const problems = [];
if (config.kind !== 'nexus-game' || config.schemaVersion !== 1) problems.push('game.config.json is not a NEXUS game (kind/schemaVersion).');
if (!Array.isArray(config.scenes) || config.scenes.length === 0) problems.push('The game has no scenes.');
for (const [id, asset] of Object.entries(config.assets ?? {})) {
  if (typeof asset.file !== 'string' || asset.file.includes('..') || asset.file.startsWith('/')) problems.push('Unsafe asset path for ' + id);
  else if (!fs.existsSync(path.join(root, asset.file))) problems.push('Missing asset file ' + asset.file);
}
if (problems.length) {
  console.error('Build stopped:\\n- ' + problems.join('\\n- '));
  console.error('(The runtime also validates the full schema when the game loads.)');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'runtime'), path.join(out, 'runtime'), { recursive: true });
// Games that only use built-in artwork have no assets/ folder.
if (fs.existsSync(path.join(root, 'assets'))) {
  fs.cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true, filter: (src) => !src.includes(path.sep + 'originals') });
}
fs.copyFileSync(path.join(root, 'index.html'), path.join(out, 'index.html'));
fs.writeFileSync(path.join(out, 'game.config.js'), '/* Generated by build.mjs from game.config.json */\\nwindow.NEXUS_GAME_CONFIG = ' + JSON.stringify(config) + ';\\n');
console.log('Built dist/ — run node serve.mjs and open http://127.0.0.1:8080');
`;

export const SERVE_MJS = `// Minimal static server for testing dist/ locally (binds to 127.0.0.1 only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };
http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = path.normalize(path.join(root, url.endsWith('/') ? url + 'index.html' : url));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(8080, '127.0.0.1', () => console.log('Serving dist/ on http://127.0.0.1:8080'));
`;

export function gameDesignMd(input: { blueprint: Blueprint; brief: GameBrief; slides: SourceSlide[]; config: GameConfig | null; blueprintNumber: number | null }): string {
  const { blueprint, brief } = input;
  const slides = new Map(input.slides.map((s) => [s.id, s]));
  const mech = MECHANICS[blueprint.coreMechanic];
  return `# Game design — ${blueprint.title}

${brief.gradeOrAge ? `**Audience:** ${brief.gradeOrAge}${brief.subject ? ` · ${brief.subject}` : ''}  ` : ''}
**Core mechanic:** ${mech.label}${mech.buildable ? '' : ' (blueprint only — no in-app builder yet)'}
**Blueprint revision:** ${input.blueprintNumber !== null ? `r${input.blueprintNumber}` : '—'}${input.config ? ` · **Game version:** v${input.config.meta.versionNumber}` : ''}

## Premise
${blueprint.premise}

## Why this mechanic fits
${blueprint.mechanicFit}

## Learning outcomes
${blueprint.learningOutcomes.map((o) => `- ${o.text} _(source: ${slideLabel(slides, o.sourceSlideIds)})_`).join('\n')}

## Progression
${blueprint.progression}

## Assessment
${blueprint.assessment}

## Scene flow
Title screen → ${blueprint.scenes.map((s) => s.title).join(' → ')} → Completion screen

${blueprint.scenes
  .map(
    (s, i) => `### ${i + 1}. ${s.title} — ${SCENE_TYPES[s.interaction.type].label} (${s.pattern})
- **Source:** ${slideLabel(slides, s.sourceSlideIds)}
- **Objective:** ${s.objective}
- **Learner sees:** ${s.visibleContent}
- **Learner does:** ${s.learnerAction}
- **Expected result:** ${s.expectedResult}
- **Success rule:** ${ruleSummary(s)}
- **Instruction:** “${s.instruction}”
- **Error feedback:** “${s.errorFeedback}”
- **Hints:** ${s.hints.map((h) => `“${h}”`).join(' → ')}
- **Completion:** ${s.completion}
- **Locks:** ${Object.entries(s.locks).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`,
  )
  .join('\n\n')}

## Accessibility requirements
${blueprint.accessibility.map((a) => `- ${a}`).join('\n') || '- (none listed)'}

## Assumptions (not stated in the source)
${blueprint.assumptions.map((a) => `- ${a}`).join('\n') || '- (none)'}

## Unresolved decisions
${blueprint.unresolvedDecisions.map((d) => `- ${d.question}${d.options.length ? ` Options: ${d.options.join(' / ')}` : ''}`).join('\n') || '- (none)'}
`;
}

export function claudeMd(input: { title: string; playable: boolean }): string {
  return `# CLAUDE.md — ${input.title}

This folder is a NEXUS Play Studio handoff for Claude Code.

## Ground rules
${
    input.playable
      ? '- The game is **data** in `game.config.json`, rendered by the runtime in `runtime/` (source in `runtime-src/`).'
      : '- The approved design is **data** in `blueprint.json`. Built NEXUS games are data in `game.config.json`, rendered by the runtime (source in `runtime-src/`).'
  }
- Answer rules are allowlisted data evaluated by \`runtime-src/shared/rules.ts\`. Never add \`eval\`, \`new Function\`, or formulas from data.
- Keep learning content traceable: every scene lists \`sourceSlideIds\` (see \`source-map.json\`) or is marked \`addedPractice\`.
- Respect scene \`locks\` (sequence, wording, answer, layout, assets) unless the creator explicitly asks otherwise.
- Keep the game static: no network calls, no learner login, no API keys. Assets stay local under \`assets/\`.
- Keep the 1920×1080 logical stage and the existing accessibility behaviour: keyboard play, non-drag alternatives,
  text + icon feedback (never colour alone), reduced motion, audio only after the learner presses Start.

${
    input.playable
      ? `## Commands
- \`node build.mjs\` — validate the config and build \`dist/\`.
- \`node serve.mjs\` — serve \`dist/\` at http://127.0.0.1:8080.
`
      : `## This is a developer handoff
The chosen mechanic has no in-app builder, so there is no playable \`game.config.json\` and nothing to build yet.
Start from GAME_DESIGN.md and TASKS.md; implement the interaction as a new scene type following README.md.
`
  }
- Animations are data in \`game.config.json\` → \`motion\` (allowlisted presets, triggers and parameters). Never add
  model-written scripts, CSS selectors, URLs or formulas; motion must not change scores, progress or answers.
- This handoff is for one grade version (see GRADE_PROFILE.md). Other grade versions are separate and must not be overwritten.

## Files
- GAME_DESIGN.md — design intent, scene flow, rules and feedback.
- TASKS.md — requested next changes and known gaps.
- ASSET_GUIDE.md — assets, roles, missing items and generation prompts.
- GRADE_PROFILE.md — who this version is for, its separate settings and the grade adaptations applied.
- ANIMATION_GUIDE.md — every animation as a readable rule, settings, runtime behaviour and what is unavailable.
- animation-manifest.json — the same animations as data, with validation results.
- design-map.json — Source-to-Screen map: slides, design frames (ids and nodes only) and artwork per screen.
- source-map.json — scene ↔ slide mapping (no speaker notes).
`;
}

export function tasksMd(input: { nextChanges: string; preflight: Preflight; blueprint: Blueprint | null; playable: boolean }): string {
  const lines: string[] = ['# TASKS', ''];
  lines.push('## Requested next changes');
  lines.push(input.nextChanges.trim() ? input.nextChanges.trim() : '_The creator did not list specific changes._', '');
  if (!input.playable && input.blueprint?.customMechanicDescription) {
    lines.push('## Build the custom mechanic', '', input.blueprint.customMechanicDescription, '');
    lines.push('Implement it as a new, allowlisted scene type in the runtime with deterministic rules, keyboard and non-drag alternatives, and tests.', '');
  }
  if (input.preflight.unsupportedScenes.length) lines.push('## Unsupported scenes', ...input.preflight.unsupportedScenes.map((s) => `- ${s}`), '');
  if (input.preflight.missingAssets.length) lines.push('## Missing assets', ...input.preflight.missingAssets.map((s) => `- ${s}`), '');
  if (input.preflight.unresolvedSourceWarnings.length) lines.push('## Source content to double-check', ...input.preflight.unresolvedSourceWarnings.map((s) => `- ${s}`), '');
  if (input.blueprint?.unresolvedDecisions.length) lines.push('## Unresolved design decisions', ...input.blueprint.unresolvedDecisions.map((d) => `- ${d.question}`), '');
  lines.push('## Known limitations', '- The export preflight does not run browser tests; playtest in a browser.', '- Images are used as supplied; check licensing before publishing.');
  return lines.join('\n') + '\n';
}

export function assetGuideMd(input: { assets: Asset[]; blueprint: Blueprint | null; config: GameConfig | null }): string {
  const used = new Set(Object.keys(input.config?.assets ?? {}));
  const rows = input.assets
    .filter((a) => used.has(a.id))
    .map((a) => `| ${a.name} | ${a.role} | ${a.kind} | ${a.width ? `${a.width}×${a.height}` : '—'} | ${a.hasAlpha ? 'yes' : 'no'} | ${a.source} | \`${input.config!.assets[a.id]!.file}\` |`);
  const needs = input.blueprint?.assetNeeds ?? [];
  return `# ASSET GUIDE

## Assets in this export
| Name | Role | Kind | Size | Transparency | Source | File |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n') || '| — | — | — | — | — | — | — |'}

Placement metadata (scale, rotation, anchor, crop) and sprite-sheet settings are in \`asset-map.json\`.

## Asset needs from the blueprint
${needs.map((n) => `- **${n.description}** (${n.role}${n.required ? ', required' : ''}) — ${n.assignedAssetId ? 'assigned' : 'not assigned: the runtime uses built-in artwork'}`).join('\n') || '- (none)'}

## Generation prompts
NEXUS does not generate images. If you need new artwork, these prompts can be pasted into an image tool of your choice:
${needs
  .filter((n) => !n.assignedAssetId && n.role !== 'audio')
  .map((n) => `- ${n.role}: “${n.description}. Flat, friendly educational illustration, clean shapes, high contrast, no text${n.role === 'character' ? ', transparent background, top-down view' : ', 1920×1080'}.”`)
  .join('\n') || '- (all needs are assigned)'}
`;
}
