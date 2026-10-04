import fs from 'node:fs';
import path from 'node:path';
import { learningAnalysisSchema, type LearningAnalysis } from '@shared/schemas/analysis.ts';
import { blueprintSchema, type Blueprint } from '@shared/schemas/blueprint.ts';
import { gameBriefSchema, type GameBrief } from '@shared/schemas/brief.ts';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import type { GameAsset, GameConfig } from '@shared/schemas/game.ts';
import type { GradeProfile } from '@shared/schemas/grade.ts';
import type { MotionPlanScope } from '@shared/schemas/motion.ts';
import { listScreens } from '@shared/motion/entities.ts';
import type { App } from '../app.ts';
import type { AiGradePlan, AiMotionPlan } from '../claude/schemas.ts';
import { REPO_ROOT } from '../config.ts';
import { createProject } from '../db/projects.ts';
import { insertDocument } from '../db/sources.ts';
import { createJob } from '../db/jobs.ts';
import { storeMedia, updateAsset } from '../services/assets.ts';
import { uploadExportedScreens } from '../services/design.ts';
import { sha256, writeFileAtomic } from '../storage.ts';
import { resolveSampleRefs } from './sample.ts';

/**
 * Bundled Grade 8 sample “Trapezium Quest” (ice theme). Its files are labelled
 * sample content and go through the real import pipelines. In demo mode (no
 * Claude key) the analysis, blueprint, grade plan and a few motion requests
 * replay prepared answers, always labelled “Demo”. Everything else is real.
 */

export const TRAPEZIUM_SAMPLE_ID = 'trapezium';
export const TRAPEZIUM_NAME = 'Trapezium Quest — Grade 8 sample';
export const TRAPEZIUM_DIR = path.join(REPO_ROOT, 'fixtures', 'trapezium');

export function isTrapeziumProject(app: App, projectId: string): boolean {
  return (app.db.get<{ sample_id: string | null }>('SELECT sample_id FROM projects WHERE id = ?', [projectId])?.sample_id ?? null) === TRAPEZIUM_SAMPLE_ID;
}

export function trapeziumBrief(): GameBrief {
  return gameBriefSchema.parse({
    schemaVersion: 1,
    prompt: 'Create a Grade 8 ice-themed game where learners help Swiftee spot trapeziums by their parallel sides, then match shapes to their names. Keep the lesson’s definition and order.',
    title: 'Trapezium Quest',
    gradeOrAge: 'Grade 8',
    subject: 'Mathematics',
    learningObjective: 'Identify trapeziums by their parallel sides, and name trapeziums, parallelograms and kites.',
    mechanic: 'drag-match',
    customIdea: '',
    durationMinutes: 10,
    optional: { story: 'Swiftee the arctic bird sorts ice floes by shape on an expedition.', difficulty: 'standard', languageNotes: '', constraints: 'Use the lesson’s inclusive definition: at least one pair of parallel sides.', accessibilityNotes: '' },
    visual: { themeId: 'ice', paletteId: 'glacier', customReferenceNote: '' },
    options: { minimalText: false, preserveSequence: true, reuseArtwork: true, allowAddedPractice: false, reducedMotion: false },
    aiInputs: { includeSpeakerNotes: true, includeHiddenSlides: false, sendVisualReferences: false, authorizedVisualSlideIds: [] },
    stage: { width: 1920, height: 1080 },
  });
}

/** Create the sample project (lesson files are added through the real pipelines afterwards). */
export function createTrapeziumProject(app: App): string {
  const id = createProject(app.db, { name: TRAPEZIUM_NAME, isSample: true, brief: trapeziumBrief() });
  app.db.run('UPDATE projects SET sample_id = ? WHERE id = ?', [TRAPEZIUM_SAMPLE_ID, id]);
  return id;
}

/**
 * Add a group of bundled sample files through the same pipelines as uploads:
 * the lesson deck (PPTX extraction job), the exported screens, or the artwork
 * (with sprite clips for Swiftee and the celebration sparkle).
 */
export async function addTrapeziumFiles(app: App, projectId: string, kind: 'lesson' | 'screens' | 'artwork'): Promise<{ jobId: string | null; added: number }> {
  if (kind === 'lesson') {
    const data = fs.readFileSync(path.join(TRAPEZIUM_DIR, 'trapezium-lesson.pptx'));
    const docId = newId(ID_PREFIX.document);
    const rel = `projects/${projectId}/sources/${docId}/original.pptx`;
    writeFileAtomic(app.storage.abs(rel), data);
    insertDocument(app.db, { id: docId, projectId, kind: 'pptx', role: 'bundled-sample', originalName: 'trapezium-lesson.pptx', storedPath: rel, sizeBytes: data.length, sha256: sha256(data), status: 'stored' });
    const { job } = createJob(app.db, { projectId, type: 'extract_pptx', input: { documentId: docId }, mode: 'local', idempotencyKey: null, model: null, maxAttempts: 2 });
    return { jobId: job.id, added: 1 };
  }
  if (kind === 'screens') {
    const dir = path.join(TRAPEZIUM_DIR, 'frames');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => ({ path: path.join(dir, f), name: f }));
    const r = await uploadExportedScreens(app, projectId, files);
    return { jobId: null, added: r.import?.frames.length ?? 0 };
  }
  const art = path.join(TRAPEZIUM_DIR, 'art');
  const provenance = { kind: 'bundled' as const, tool: '', note: 'Bundled sample artwork (Trapezium Quest)', figma: null, recordedAt: new Date().toISOString() };
  const roles: Array<[string, 'background' | 'character' | 'ui' | 'object' | 'audio']> = [
    ['ice-background.png', 'background'],
    ['swiftee-sheet.png', 'character'],
    ['panel-blank.png', 'ui'],
    ['button-primary.png', 'ui'],
    ['celebration-sparkle.png', 'object'],
    ['chime.wav', 'audio'],
  ];
  let added = 0;
  for (const [file, role] of roles) {
    const row = await storeMedia(app, projectId, fs.readFileSync(path.join(art, file)), { originalName: file, source: 'bundled-sample', role, provenance });
    added++;
    if (file === 'swiftee-sheet.png') {
      updateAsset(app, row.id, {
        name: 'Swiftee',
        metadata: {
          alt: 'Swiftee, the expedition’s arctic bird guide',
          sprite: { frameWidth: 256, frameHeight: 256, columns: 5, rows: 2, spacing: 0, frameCount: 10, fps: 8, anchorX: 0.5, anchorY: 1, clips: [{ name: 'idle', from: 0, to: 1, fps: 2, loop: true }, { name: 'wave', from: 2, to: 5, fps: 8, loop: false }, { name: 'celebrate', from: 6, to: 9, fps: 8, loop: false }] },
        },
      });
    }
    if (file === 'celebration-sparkle.png') {
      updateAsset(app, row.id, { name: 'Celebration sparkle', metadata: { alt: 'Snow sparkle burst', sprite: { frameWidth: 200, frameHeight: 200, columns: 6, rows: 1, spacing: 0, frameCount: 6, fps: 12, anchorX: 0.5, anchorY: 0.5, clips: [{ name: 'sparkle', from: 0, to: 5, fps: 12, loop: false }] } } });
    }
    if (file === 'panel-blank.png') updateAsset(app, row.id, { name: 'Blank ice panel', metadata: { alt: 'Blank frosted instruction panel' } });
    if (file === 'button-primary.png') updateAsset(app, row.id, { name: 'Ice button', metadata: { alt: 'Text-free ice button' } });
  }
  return { jobId: null, added };
}

// ───────────── prepared demo content (resolved against this project's slides and assets) ─────────────

const S = (n: number) => `@slide:${256 + n}`;

const ANALYSIS = {
  schemaVersion: 1,
  topic: 'Trapeziums and their parallel sides',
  summary: 'The deck defines a trapezium as a quadrilateral with at least one pair of parallel sides (so parallelograms count), shows how to spot parallel sides, contrasts trapeziums with parallelograms and kites, and ends with a matching task.',
  concepts: [
    { id: 'cpt-1', name: 'Trapezium (inclusive definition)', description: 'A quadrilateral with at least one pair of parallel sides; parallelograms are included.', sourceSlideIds: [S(2)] },
    { id: 'cpt-2', name: 'Parallel sides', description: 'Sides that never meet however far they are extended; arrow marks show them.', sourceSlideIds: [S(3)] },
    { id: 'cpt-3', name: 'Classifying quadrilaterals', description: 'Count pairs of parallel sides: one (trapezium), two (parallelogram, also a trapezium), none (for example a kite).', sourceSlideIds: [S(4)] },
  ],
  prerequisites: [{ id: 'pre-1', text: 'Knows what parallel lines are.', sourceSlideIds: [S(3)], inferred: true }],
  objectives: [
    { id: 'obj-1', text: 'Identify whether a quadrilateral is a trapezium by checking for at least one pair of parallel sides.', sourceSlideIds: [S(2), S(3), S(4)], addedPractice: false, status: 'proposed', origin: 'demo', locked: false },
    { id: 'obj-2', text: 'Name trapeziums, parallelograms and kites by their most specific name.', sourceSlideIds: [S(4), S(5)], addedPractice: false, status: 'proposed', origin: 'demo', locked: false },
  ],
  examples: [{ id: 'ex-1', text: 'A parallelogram has two pairs of parallel sides, so it is also a trapezium.', sourceSlideIds: [S(2), S(4)], required: true }],
  questions: [{ id: 'q-1', prompt: 'Is a kite a trapezium?', answer: 'No — it has no parallel sides.', sourceSlideIds: [S(4)], addedPractice: false }],
  interactions: [
    { id: 'int-1', mechanic: 'drag-match', description: 'Sort shapes by whether they have at least one pair of parallel sides.', sourceSlideIds: [S(3), S(4)], addedPractice: false },
    { id: 'int-2', mechanic: 'drag-match', description: 'Match each shape to its most specific name.', sourceSlideIds: [S(5)], addedPractice: false },
  ],
  openQuestions: ['The design screens say “exactly one pair of parallel sides”; the deck says “at least one pair”. Which definition should the game use?', 'Slide 6 (teacher answer key) is hidden and was excluded.'],
};

const card = (id: string, label: string, image: string) => ({ id, label, imageAssetId: `@asset:${image}` });

const BLUEPRINT = {
  schemaVersion: 1,
  title: 'Trapezium Quest',
  learningOutcomes: [
    { id: 'out-1', text: 'Identify whether a quadrilateral is a trapezium by checking for at least one pair of parallel sides.', sourceSlideIds: [S(2), S(3), S(4)], addedPractice: false },
    { id: 'out-2', text: 'Name trapeziums, parallelograms and kites by their most specific name.', sourceSlideIds: [S(4), S(5)], addedPractice: false },
  ],
  coreMechanic: 'drag-match',
  customMechanicDescription: null,
  premise: 'Swiftee the arctic bird is sorting ice floes by shape. Help spot the trapeziums by their parallel sides, then name every shape.',
  progression: 'An introduction with the lesson’s definition, a guided identification with hints, then a matching task that uses the most specific names.',
  assessment: 'Each sort is checked by a fixed rule from the lesson table; feedback points back to the parallel sides.',
  assetNeeds: [
    { id: 'bg-ice', role: 'background', description: 'Ice expedition background', assignedAssetId: '@asset:ice-background.png', required: false },
    { id: 'char-swiftee', role: 'character', description: 'Swiftee, the guide', assignedAssetId: '@asset:swiftee-sheet.png', required: false },
  ],
  accessibility: ['Every card can be selected and placed with clicks or keys — no dragging required.', 'Feedback uses words and icons, never colour alone.', 'Motion follows the reduced-motion setting.'],
  unresolvedDecisions: [],
  assumptions: ['The lesson’s inclusive definition is used throughout (parallelograms are trapeziums).'],
  mechanicFit: 'Sorting and matching cards directly practises classifying shapes by their parallel sides.',
  scenes: [
    {
      id: 'scn_trap_intro',
      title: 'What is a trapezium?',
      pattern: 'discover',
      sourceSlideIds: [S(2), S(3)],
      addedPractice: false,
      objective: 'Recall the definition of a trapezium.',
      visibleContent: 'A concept card with the lesson’s definition and how to spot parallel sides.',
      learnerAction: 'Read the points and continue.',
      expectedResult: 'The learner continues to the identification task.',
      instruction: 'A trapezium has at least one pair of parallel sides.',
      interaction: { type: 'info', points: ['A trapezium is a quadrilateral with at least one pair of parallel sides.', 'Parallel sides never meet, however far they are extended.', 'So every parallelogram is also a trapezium.'], illustration: 'none', continueLabel: 'Start the expedition' },
      successFeedback: 'Let’s spot some trapeziums.',
      errorFeedback: 'Read the points, then continue.',
      hints: ['Look for sides that never meet.'],
      next: 'scn_trap_identify',
      assetNeedIds: { background: 'bg-ice', character: 'char-swiftee' },
      completion: 'The learner selects Start the expedition.',
      difficulty: 'gentle',
      locks: { sequence: true, wording: false, answer: false, layout: false, assets: false },
      origin: 'demo',
    },
    {
      id: 'scn_trap_identify',
      title: 'Spot the parallel sides',
      pattern: 'manipulate',
      sourceSlideIds: [S(3), S(4)],
      addedPractice: false,
      objective: 'Decide whether each shape has at least one pair of parallel sides.',
      visibleContent: 'Three shape cards and two bays: “Has parallel sides” and “No parallel sides”.',
      learnerAction: 'Place each shape in a bay.',
      expectedResult: 'The trapezium and the parallelogram have parallel sides; the kite has none.',
      instruction: 'Drag each shape to the right group.',
      interaction: {
        type: 'drag-match',
        items: [card('shape-a', 'Shape A', 'trapezium.png'), card('shape-b', 'Shape B', 'parallelogram.png'), card('shape-c', 'Shape C', 'kite.png')],
        targets: [
          { id: 'has-parallel', label: 'Has parallel sides', imageAssetId: null, capacity: 3 },
          { id: 'no-parallel', label: 'No parallel sides', imageAssetId: null, capacity: 3 },
        ],
        rule: { kind: 'match-sets', accepts: [{ itemId: 'shape-a', targetIds: ['has-parallel'] }, { itemId: 'shape-b', targetIds: ['has-parallel'] }, { itemId: 'shape-c', targetIds: ['no-parallel'] }] },
        trayPosition: 'bottom',
      },
      successFeedback: 'Right — at least one pair of parallel sides makes a trapezium.',
      errorFeedback: 'Check each shape for sides that never meet.',
      hints: ['Arrow marks show parallel sides.', 'A parallelogram has two pairs — that still counts.'],
      next: 'scn_trap_match',
      assetNeedIds: { background: 'bg-ice', character: 'char-swiftee' },
      completion: 'All three shapes are in the correct bay.',
      difficulty: 'standard',
      locks: { sequence: true, wording: false, answer: false, layout: false, assets: false },
      origin: 'demo',
    },
    {
      id: 'scn_trap_match',
      title: 'Match the shapes',
      pattern: 'apply',
      sourceSlideIds: [S(4), S(5)],
      addedPractice: false,
      objective: 'Name each shape by its most specific name.',
      visibleContent: 'Three shape cards and three name bays: Trapezium, Parallelogram, Kite.',
      learnerAction: 'Place each shape on its name.',
      expectedResult: 'Each shape is on its most specific name.',
      instruction: 'Match each shape to its most specific name.',
      interaction: {
        type: 'drag-match',
        items: [card('shape-1', 'Shape 1', 'trapezium.png'), card('shape-2', 'Shape 2', 'parallelogram.png'), card('shape-3', 'Shape 3', 'kite.png')],
        targets: [
          { id: 't-trapezium', label: 'Trapezium', imageAssetId: null, capacity: 1 },
          { id: 't-parallelogram', label: 'Parallelogram', imageAssetId: null, capacity: 1 },
          { id: 't-kite', label: 'Kite', imageAssetId: null, capacity: 1 },
        ],
        rule: { kind: 'match-sets', accepts: [{ itemId: 'shape-1', targetIds: ['t-trapezium'] }, { itemId: 'shape-2', targetIds: ['t-parallelogram'] }, { itemId: 'shape-3', targetIds: ['t-kite'] }] },
        trayPosition: 'bottom',
      },
      successFeedback: 'Every shape has its most specific name.',
      errorFeedback: 'A parallelogram is also a trapezium, but its most specific name is parallelogram.',
      hints: ['Count the pairs of parallel sides first.', 'Two pairs: parallelogram. One pair: trapezium. None: kite.'],
      next: null,
      assetNeedIds: { background: 'bg-ice', character: 'char-swiftee' },
      completion: 'All shapes are on their names.',
      difficulty: 'standard',
      locks: { sequence: true, wording: false, answer: false, layout: false, assets: false },
      origin: 'demo',
    },
  ],
};

export function trapeziumAnalysis(app: App, projectId: string): LearningAnalysis {
  return learningAnalysisSchema.parse(resolveSampleRefs(app, projectId, ANALYSIS));
}

export function trapeziumBlueprint(app: App, projectId: string): Blueprint {
  return blueprintSchema.parse(resolveSampleRefs(app, projectId, BLUEPRINT));
}

/** Prepared Grade 8 plan for the sample (presentation; the learning item shows how challenge items are routed). */
export function demoGradePlan(config: GameConfig, profile: GradeProfile, mode: 'presentation' | 'challenge'): AiGradePlan | null {
  if (!config.scenes.some((s) => s.id === 'scn_trap_identify') || profile.grade !== 8) return null;
  const item = (p: Partial<AiGradePlan['items'][number]> & Pick<AiGradePlan['items'][number], 'area' | 'summary' | 'rationale'>): AiGradePlan['items'][number] => ({
    sceneId: null,
    field: null,
    valueText: null,
    valueHints: null,
    valueBool: null,
    valueDensity: null,
    sourceSlideIds: [],
    addedPractice: false,
    changesLearning: false,
    ...p,
  });
  const identifySlides = config.scenes.find((s) => s.id === 'scn_trap_identify')?.sourceSlideIds ?? [];
  const matchSlides = config.scenes.find((s) => s.id === 'scn_trap_match')?.sourceSlideIds ?? [];
  // The learning item is shown in both modes; in presentation mode it is listed, never applied.
  return {
    summary: 'Grade 8 (Grades 6–8 preset): a challenge framing for the identification task, step-by-step hints that keep the lesson’s inclusive definition, cleaner panels, and motion that explains relationships.',
    items: [
      item({ area: 'language', sceneId: 'scn_trap_identify', field: 'instruction', valueText: 'Sort each shape: does it have at least one pair of parallel sides?', summary: 'Turn the instruction into a clear question that names the rule.', rationale: 'Grades 6–8: discovery and challenge framing with precise wording from the lesson.', sourceSlideIds: identifySlides }),
      item({ area: 'hints', sceneId: 'scn_trap_identify', field: 'feedback.hints', valueHints: ['Parallel sides point the same way and never meet.', 'Look for arrow marks — they show parallel sides.', 'A parallelogram has two pairs, so it still counts.'], summary: 'Three progressive hints instead of two.', rationale: 'Progressive reasoning: each hint adds one step; the last restates the lesson’s inclusive definition.', sourceSlideIds: identifySlides }),
      item({ area: 'feedback', sceneId: 'scn_trap_match', field: 'feedback.error', valueText: 'Count the pairs of parallel sides first: two pairs, one pair, or none?', summary: 'Error feedback that points to the reasoning step.', rationale: 'Feedback that explains the relationship instead of only saying “not yet”.', sourceSlideIds: matchSlides }),
      item({ area: 'layout', sceneId: null, field: 'layout.density', valueDensity: 'compact', summary: 'Cleaner, more compact instruction panels.', rationale: 'Grades 6–8 preset: cleaner instruction panels leave room for the task.' }),
      item({ area: 'language', summary: 'Keep the lesson’s definition (“at least one pair”); the design screen’s “exactly one pair” stays a flagged conflict.', rationale: 'Source definitions are never changed by a grade plan.', sourceSlideIds: identifySlides }),
      item({ area: 'difficulty', summary: 'Added practice: a right-trapezium card in the identification task.', rationale: 'A right trapezium is a common misconception for Grade 8 — it has one pair of parallel sides.', addedPractice: true, changesLearning: true }),
    ],
    motionPurpose: 'Motion that explains relationships: highlight the parallel sides and the task, confirm valid drops, celebrate briefly once — no decorative bouncing for Grade 8.',
    assumptions: ['Learners have met parallel lines before (prerequisite from the lesson).', 'The Grades 6–8 product preset is a starting point, not a validated rule.'],
    curriculumNote: `Curriculum alignment is not verified.${mode === 'challenge' ? ' Learning changes go to blueprint review.' : ''}`,
  };
}

/**
 * Prepared answers to motion requests for the bundled samples. Matching is by
 * keywords; ids are taken from the game itself, and every row is validated
 * afterwards exactly like Claude's rows.
 */
export function matchDemoMotion(config: GameConfig, request: string, scope: MotionPlanScope, library: GameAsset[] = []): AiMotionPlan | null {
  const q = request.toLowerCase();
  if (!q.trim()) return null;
  const screens = listScreens(config);
  const inScope = scope.kind === 'screen' ? screens.find((s) => s.id === scope.screenId) : null;
  const pick = (pred: (s: (typeof screens)[number]) => boolean) => inScope ?? screens.find(pred) ?? null;
  const row = (screenId: string, target: string, presetId: AiMotionPlan['add'][number]['presetId'], triggerEvent: AiMotionPlan['add'][number]['triggerEvent'], extra: Partial<AiMotionPlan['add'][number]> = {}): AiMotionPlan['add'][number] => ({
    screenId,
    target,
    presetId,
    triggerEvent,
    triggerControl: null,
    triggerEntity: null,
    params: [],
    delayMs: 0,
    durationMs: 0,
    easing: 'ease-out',
    repeat: 1,
    afterIndex: null,
    afterExistingId: null,
    reducedMotion: 'static',
    assetId: null,
    soundAssetId: null,
    soundVolume: null,
    purpose: 'decorative',
    evidence: 'request',
    ...extra,
  });
  const empty = (summary: string): AiMotionPlan => ({ summary, resolved: [], add: [], remove: [], settings: null, unsupported: [], notes: [] });
  const plan = empty('Prepared demo answer (not Claude).');
  const selected = /\[((?:target|item|card|el|obj|button)[:\-][A-Za-z0-9:_.-]+)\]/.exec(request)?.[1] ?? null;

  if (/(talk|lip.?sync|speak|say )/.test(q)) plan.unsupported.push({ request: 'Make the character talk', reason: 'There is no speech or lip-sync generation, and no narration is invented.', alternative: 'Upload a talking clip (sprite frames) and an audio file; keep the words in the instruction panel.', handoff: false });
  if (/(shake|strobe|flash)/.test(q)) plan.unsupported.push({ request: 'Shake or flash', reason: 'Screen shake, strobe and rapid flashing are excluded (disorienting, photosensitivity).', alternative: 'Use the retry outline cue or an outline highlight.', handoff: false });
  if (/confetti/.test(q) && !/no (full.?screen )?confetti/.test(q)) plan.unsupported.push({ request: 'Full-screen confetti', reason: 'Celebrations stay small and skippable so they never hide content.', alternative: 'Use a small particle burst or a celebration clip.', handoff: false });

  if (/wave/.test(q)) {
    const s = pick((x) => x.kind === 'scene' && x.entities.some((e) => e.id === 'character'));
    if (s) {
      plan.resolved.push({ phrase: 'Swiftee', screenId: s.id, entityId: 'character', assetId: s.entities.find((e) => e.id === 'character')?.assetId ?? null, label: s.entities.find((e) => e.id === 'character')?.label ?? 'Character' });
      plan.add.push(row(s.id, 'character', 'character-clip', 'scene-entered', { params: [{ name: 'clip', value: 'wave' }], durationMs: 1000 }));
      if (/(reveal|then).*(instruction|panel)/.test(q)) plan.add.push(row(s.id, 'instruction', 'fade-in', 'scene-entered', { afterIndex: 0, durationMs: 500, purpose: 'instructional' }));
      if (/stationary|still|don.?t move|keep the trapez/.test(q)) plan.notes.push('The shape cards stay stationary: no movement was added to them.');
      plan.summary = `On ${s.label}: Swiftee waves when the screen opens${plan.add.length > 1 ? ', then the instruction panel fades in' : ''}.`;
    }
  }
  if (/celebrat/.test(q)) {
    const s = pick((x) => x.kind === 'scene' && x.type !== 'info');
    const sprite = [...Object.values(config.assets), ...library].find((a) => a.sprite && /celebrat|sparkle/i.test(a.alt));
    if (s && sprite) {
      plan.resolved.push({ phrase: 'the uploaded celebration sprite', screenId: null, entityId: null, assetId: sprite.id, label: sprite.alt });
      plan.add.push(row(s.id, 'instruction', 'celebration-clip', 'correct-answer', { assetId: sprite.id, params: [{ name: 'clip', value: sprite.sprite!.clips[0]?.name ?? 'sparkle' }], durationMs: 800, repeat: 1 }));
      plan.summary = `After the correct answer on ${s.label}, the uploaded celebration sprite plays once (learners can skip it).`;
    } else if (s) {
      plan.unsupported.push({ request: 'Use the uploaded celebration sprite', reason: 'No celebration sprite with a clip is packaged in this game version.', alternative: 'Upload the sprite, set up its clip in Assets, and use it on a screen first.', handoff: false });
    }
  }
  if (/(remove|no|without).*(decorat|bounc)/.test(q)) {
    const removable = config.motion.bindings.filter((b) => b.purpose === 'decorative' && (scope.kind === 'project' || b.screenId === scope.screenId) && ['attention-cue', 'pop-in', 'particle-burst', 'slide-in'].includes(b.presetId));
    plan.remove.push(...removable.map((b) => ({ id: b.id, reason: 'Decorative movement removed for this grade version.' })));
    const kept = config.motion.bindings.filter((b) => b.presetId === 'outline-highlight' && (scope.kind === 'project' || b.screenId === scope.screenId));
    if (kept.length) plan.notes.push(`Kept ${kept.length} outline highlight(s) that point at the task.`);
    plan.settings = { profile: null, pacing: null, decorativeIntensity: 'off', sound: null, lowEffects: null };
    plan.summary = `Removes ${removable.length} decorative animation(s) and turns decorative effects off; instructional highlights stay.`;
  }
  if (/(success outline|outline).*(target|drop)|drop target/.test(q)) {
    const s = pick((x) => x.type === 'drag-match');
    const target = selected && s?.entities.some((e) => e.id === selected) ? selected : (s?.entities.find((e) => e.kind === 'target')?.id ?? null);
    if (s && target) {
      plan.resolved.push({ phrase: 'this drop target', screenId: s.id, entityId: target, assetId: null, label: s.entities.find((e) => e.id === target)!.label });
      plan.add.push(row(s.id, target, 'success-highlight', 'valid-drop', { triggerEntity: target, durationMs: 700, purpose: 'feedback', reducedMotion: 'stepwise' }));
      if (/keep.*(figma|layout)|layout unchanged/.test(q)) plan.notes.push('The Figma layout is unchanged: only an outline is added.');
      plan.summary = `A short success outline on ${s.entities.find((e) => e.id === target)!.label} when something lands on it.`;
    }
  }
  if (/(two|2) units? right/.test(q) || /move it .*units/.test(q)) {
    const s = pick((x) => x.type === 'coordinate-navigation');
    if (s) {
      plan.add.push(row(s.id, 'mover', 'move-by', 'correct-answer', { params: [{ name: 'dx', value: '2' }, { name: 'dy', value: '3' }, { name: 'units', value: 'grid' }], durationMs: 1200, purpose: 'instructional' }));
      plan.summary = `After the correct route on ${s.label}, the mover glides 2 units right and 3 units up (the answer check is unchanged).`;
    } else plan.unsupported.push({ request: 'Move by grid units', reason: 'This game has no coordinate screen, so grid units do not apply.', alternative: 'Use “Move by an amount” in stage pixels.', handoff: false });
  }
  if (plan.add.length === 0 && plan.remove.length === 0 && plan.unsupported.length === 0) return null;
  return plan;
}

