import type { Blueprint } from '../schemas/blueprint.ts';
import type { DesignFrame } from '../schemas/design.ts';
import { emptyScreen, type ScreenMapEntry, type SourceConflict, type SourceScreenMapping } from '../schemas/screens.ts';
import { overlap, tokens } from '../similarity.ts';
import { detectConflicts, type TextSource } from './conflicts.ts';

/**
 * Suggest a Source-to-Screen map from evidence only. Slides come from each
 * scene's reviewed source links in the blueprint; Figma frames are linked only
 * when their text and names share distinctive words with the scene — never by
 * equal counts or matching numbers (numbers in frame names are ignored).
 * Every suggested row starts unreviewed.
 */

export interface SuggestAsset {
  id: string;
  role: string;
  name: string;
  kind: 'image' | 'audio';
  sprite: { clips: Array<{ name: string }> } | null;
}

export interface SuggestInput {
  blueprint: Blueprint;
  /** inLesson: included and not hidden — used to check design definitions against the whole lesson. */
  slides: Array<{ id: string; text: string; title: string; inLesson?: boolean }>;
  frames: DesignFrame[];
  assets: SuggestAsset[];
}

export function frameText(f: DesignFrame): string {
  return [f.name, ...f.elements.filter((e) => e.text).map((e) => e.text!.characters)].join('\n');
}

function sceneText(scene: Blueprint['scenes'][number], slides: SuggestInput['slides']): string {
  const it = scene.interaction as Record<string, unknown>;
  const labels: string[] = [];
  for (const key of ['items', 'targets', 'landmarks']) {
    const arr = it[key];
    if (Array.isArray(arr)) for (const x of arr) if (x && typeof x === 'object' && typeof (x as { label?: unknown }).label === 'string') labels.push((x as { label: string }).label);
  }
  if (Array.isArray(it.points)) labels.push(...(it.points as string[]));
  const slideTitles = scene.sourceSlideIds.map((id) => slides.find((s) => s.id === id)?.title ?? '').filter(Boolean);
  return [scene.title, scene.instruction, scene.learnerAction, ...labels, ...slideTitles].join(' ');
}

const STATE_HINTS: Array<[RegExp, string]> = [
  [/\bhint\b/i, 'hint'],
  [/\b(correct|success|right|solved)\b/i, 'correct'],
  [/\b(wrong|incorrect|retry|try again|error)\b/i, 'retry'],
  [/\b(intro|start|default)\b/i, 'default'],
];

function stateName(frameName: string, used: Set<string>): string {
  const hit = STATE_HINTS.find(([re]) => re.test(frameName))?.[1] ?? 'alternate';
  let name = hit;
  for (let i = 2; used.has(name); i++) name = `${hit}-${i}`;
  used.add(name);
  return name;
}

/** Best scene per frame, by shared distinctive words. */
export function frameScores(frames: DesignFrame[], targets: Array<{ id: string; text: string }>): Map<string, { targetId: string; score: number; shared: number }> {
  const out = new Map<string, { targetId: string; score: number; shared: number }>();
  for (const f of frames) {
    const ft = tokens(frameText(f));
    let best: { targetId: string; score: number; shared: number } | null = null;
    let tie = false;
    for (const t of targets) {
      const o = overlap(ft, tokens(t.text));
      if (o.shared < 2 || o.score < 0.25) continue;
      if (!best || o.score > best.score + 1e-9 || (Math.abs(o.score - best.score) < 1e-9 && o.shared > best.shared)) {
        best = { targetId: t.id, score: o.score, shared: o.shared };
        tie = false;
      } else if (Math.abs(o.score - best.score) < 1e-9 && o.shared === best.shared) tie = true;
    }
    if (best && !tie) out.set(f.id, best);
  }
  return out;
}

// Frame names that clearly say “title screen” or “end screen”.
const TITLE_NAME = /\b(intro|title|start|home|cover|splash|welcome)\b/i;
const END_NAME = /\b(well\s*done|complete[ds]?|completion|finish(ed)?|congrat\w*|the\s+end|results?|summary)\b/i;

const nameTokens = (name: string) => tokens(name.replace(/[–—-]/g, ' '));

/** A second frame is a state of the primary one only if it is named as a variant of it (or as a hint/correct/retry state of it). */
function isStateOf(primary: DesignFrame, other: DesignFrame): boolean {
  const a = nameTokens(primary.name);
  const b = nameTokens(other.name);
  const o = overlap(a, b);
  if (a.size && o.shared / a.size >= 0.6) return true;
  return o.shared >= 1 && STATE_HINTS.some(([re]) => re.test(other.name));
}

function pickAsset(assets: SuggestAsset[], role: string, word: RegExp | null): string | null {
  const pool = assets.filter((a) => a.kind === 'image' && a.role === role);
  if (!word) return pool[0]?.id ?? null;
  return pool.find((a) => word.test(a.name))?.id ?? null;
}

export function suggestMapping(input: SuggestInput): SourceScreenMapping {
  const { blueprint, slides, frames, assets } = input;
  const characterSprite = assets.find((a) => a.kind === 'image' && a.role === 'character' && a.sprite)?.id ?? null;
  const character = characterSprite ?? assets.find((a) => a.kind === 'image' && a.role === 'character')?.id ?? null;
  const idleClip = characterSprite ? (assets.find((a) => a.id === characterSprite)!.sprite!.clips.find((c) => c.name === 'idle')?.name ?? null) : null;
  const background = pickAsset(assets, 'background', null);
  const panel = pickAsset(assets, 'ui', /panel|card|board/i);
  const button = pickAsset(assets, 'ui', /button|btn/i);

  const targets = [
    { id: 'title', text: `${blueprint.title} ${blueprint.premise} start begin play` },
    ...blueprint.scenes.map((s) => ({ id: s.id, text: sceneText(s, slides) })),
    { id: 'completion', text: `complete completed well done finished congratulations ${blueprint.title}` },
  ];
  const scores = frameScores(frames, targets);
  // Name evidence for the title and end screens (only when no scene is named the same way).
  for (const f of frames) {
    const end = END_NAME.exec(f.name);
    const start = TITLE_NAME.exec(f.name);
    if (end && !start && !blueprint.scenes.some((s) => new RegExp(`\\b${end[0]}\\b`, 'i').test(s.title))) scores.set(f.id, { targetId: 'completion', score: 1, shared: 1 });
    else if (start && !end && !blueprint.scenes.some((s) => new RegExp(`\\b${start[0]}\\b`, 'i').test(s.title))) scores.set(f.id, { targetId: 'title', score: 1, shared: 1 });
  }

  const rows: ScreenMapEntry[] = [];
  const pushRow = (id: string, kind: ScreenMapEntry['kind'], title: string, slideIds: string[]) => {
    const row = emptyScreen(id, kind, title.slice(0, 80), slideIds);
    const ranked = frames.filter((f) => scores.get(f.id)?.targetId === id).sort((a, b) => scores.get(b.id)!.score - scores.get(a.id)!.score);
    // Further frames join as states only when they are named as variants of the primary frame; others stay unlinked for review.
    const linked = ranked.length ? [ranked[0]!, ...ranked.slice(1).filter((f) => isStateOf(ranked[0]!, f))] : [];
    const used = new Set<string>();
    row.frames = linked.slice(0, 8).map((f, i) => ({ frameId: f.id, state: i === 0 ? 'default' : stateName(f.name, used), primary: i === 0 }));
    if (row.frames.length) {
      row.roles = { ...row.roles, layout: 'figma' };
      const primary = frames.find((f) => f.id === row.frames[0]!.frameId)!;
      // Regions from clearly named layers; nothing else is turned into a game layer automatically.
      for (const e of primary.elements) {
        if (/instruction|prompt|question/i.test(e.name) && e.kind === 'rect' && e.depth <= 2 && !row.layers.some((l) => l.use === 'instruction-region')) {
          row.layers.push({ elementId: e.id, use: 'instruction-region' });
        }
        if (/play\s*area|playfield|board|game\s*area/i.test(e.name) && e.kind === 'rect' && !row.layers.some((l) => l.use === 'play-region')) row.layers.push({ elementId: e.id, use: 'play-region' });
      }
      // An uploaded background beats a picture of the whole design (which has text baked in).
      const bgElement = primary.elements.find((e) => e.kind === 'image' && e.assetId && /background|backdrop|\bbg\b/i.test(e.name) && e.fidelity !== 'reference');
      if (background) row.background = { kind: 'asset', assetId: background, frameId: null, elementId: null, confirmedClean: false };
      else if (bgElement) row.background = { kind: 'frame-element', assetId: null, frameId: primary.id, elementId: bgElement.id, confirmedClean: false };
    } else if (background) {
      row.background = { kind: 'asset', assetId: background, frameId: null, elementId: null, confirmedClean: false };
    }
    if (!slideIds.length && kind === 'scene') row.roles = { ...row.roles, content: 'creator' };
    row.assets = { character, characterClip: character && character === characterSprite ? idleClip : null, panel: kind === 'scene' ? panel : null, button: kind === 'scene' ? button : null };
    rows.push(row);
  };

  pushRow('title', 'title', 'Title', []);
  for (const s of blueprint.scenes) pushRow(s.id, 'scene', s.title, s.sourceSlideIds);
  pushRow('completion', 'completion', 'Completion', []);

  // Conflicts: lesson text of the linked slides vs text in the linked frames.
  for (const row of rows) {
    const ppt: TextSource[] = row.slideIds.map((id) => ({ text: slides.find((s) => s.id === id)?.text ?? '', slideIds: [id] })).filter((t) => t.text);
    if (row.kind === 'scene') {
      const scene = blueprint.scenes.find((s) => s.id === row.screenId);
      if (scene) ppt.push({ text: `${scene.instruction}`, slideIds: scene.sourceSlideIds });
    }
    const figma: TextSource[] = row.frames.flatMap((l) => {
      const f = frames.find((x) => x.id === l.frameId);
      return (f?.elements ?? []).filter((e) => e.text).map((e) => ({ text: e.text!.characters, frameId: f!.id, elementId: e.id }));
    });
    const scene = blueprint.scenes.find((s) => s.id === row.screenId);
    const labels = scene ? labelsOf(scene) : [];
    // Definitions and answer rules are checked against the whole lesson: a design that redefines a term conflicts wherever the lesson defines it.
    const lesson: TextSource[] = figma.length ? slides.filter((s) => s.inLesson !== false && !row.slideIds.includes(s.id) && s.text).map((s) => ({ text: s.text, slideIds: [s.id] })) : [];
    const found = [...detectConflicts(ppt, figma, labels), ...detectConflicts(lesson, figma, []).filter((c) => c.kind === 'definition' || c.kind === 'answer-rule')];
    const seen = new Set<string>();
    const unique = found.filter((c) => {
      // One conflict per design statement (flagged on the first, primary frame), with the linked slides' evidence first.
      const key = `${c.kind}|${c.figmaText}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    row.conflicts = unique.slice(0, 40).map((c, i): SourceConflict => ({ ...c, id: `cf-${row.screenId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'row'}-${i + 1}`, status: 'open', resolution: null }));
  }
  return { screens: rows };
}

export function labelsOf(scene: Blueprint['scenes'][number]): string[] {
  const it = scene.interaction as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['items', 'targets', 'landmarks']) {
    const arr = it[key];
    if (Array.isArray(arr)) for (const x of arr) if (x && typeof x === 'object' && typeof (x as { label?: unknown }).label === 'string') out.push((x as { label: string }).label);
  }
  return out;
}

/**
 * Keep the creator's reviewed rows and add suggestions only for screens the
 * blueprint gained since; rows for removed scenes are dropped (reported).
 */
export function mergeWithBlueprint(current: SourceScreenMapping, suggestion: SourceScreenMapping): { mapping: SourceScreenMapping; added: string[]; removed: string[] } {
  const keep = new Map(current.screens.map((s) => [s.screenId, s]));
  const ids = new Set(suggestion.screens.map((s) => s.screenId));
  const added: string[] = [];
  const screens = suggestion.screens.map((s) => {
    const existing = keep.get(s.screenId);
    if (existing) return { ...existing, title: s.title, kind: s.kind };
    added.push(s.screenId);
    return s;
  });
  const removed = current.screens.filter((s) => !ids.has(s.screenId)).map((s) => s.screenId);
  return { mapping: { screens }, added, removed };
}
