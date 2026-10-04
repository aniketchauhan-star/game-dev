import { checkInteraction } from '@shared/attainability.ts';
import { blueprintSchema, checkBlueprint, NO_LOCKS, type Blueprint, type BlueprintScene } from '@shared/schemas/blueprint.ts';
import type { GameBrief } from '@shared/schemas/brief.ts';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { MECHANICS } from '@shared/registry.ts';
import type { App } from '../../app.ts';
import type { StructuredResult } from '../../claude/gateway.ts';
import { aiOutlineSchema, aiSceneBatchSchema, type AiOutline, type AiSceneDetail, type SlideDigest } from '../../claude/schemas.ts';
import { allowedMechanicsNote, analysisSummaryBlock, briefBlock, digestBlock, OUTLINE_SYSTEM, SCENES_SYSTEM, slideBlock, slideIndex } from '../../claude/prompts.ts';
import { listAssetRows } from '../../db/assets.ts';
import { parseJson } from '../../db/db.ts';
import { currentAnalysis, getAnalysis, insertBlueprintRevision } from '../../db/learning.ts';
import { getProjectRow, projectBrief } from '../../db/projects.ts';
import { currentSnapshot, listSlides } from '../../db/sources.ts';
import { loadSampleBlueprint } from '../../demo/sample.ts';
import { JobFailure, type JobContext } from '../context.ts';

const clip = (s: string, n: number) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Slide material for blueprint prompts: full text for small decks, saved digests for large ones. */
export function sourceMaterial(app: App, slides: SourceSlide[], brief: GameBrief): string {
  const includeNotes = brief.aiInputs.includeSpeakerNotes;
  const full = slides.map((s) => slideBlock(s, { includeNotes }));
  if (full.reduce((n, b) => n + b.length, 0) <= 40_000) return full.join('\n\n');
  return slides
    .map((s) => {
      const row = app.db.get<{ digest_json: string }>('SELECT digest_json FROM slide_digests WHERE slide_id = ? ORDER BY created_at DESC LIMIT 1', [s.id]);
      const d = row ? parseJson<SlideDigest | null>(row.digest_json, null) : null;
      return d ? digestBlock(s, d) : slideBlock(s, { includeNotes: false });
    })
    .join('\n\n');
}

export function assetCatalog(app: App, projectId: string): string {
  const rows = listAssetRows(app.db, projectId);
  if (rows.length === 0) return 'Creator assets: none uploaded.';
  return `Creator assets (use these ids for assignedAssetId only when they fit):\n${rows
    .map((a) => `- ${a.id}: ${a.kind}, role ${a.role}, "${a.name}"${a.width ? ` ${a.width}×${a.height}` : ''}${a.has_alpha ? ', transparent' : ''}`)
    .join('\n')}`;
}

function outlineProblems(o: AiOutline, brief: GameBrief, included: Set<string>): string[] {
  const problems: string[] = [];
  const allowed = new Set(MECHANICS[brief.mechanic ?? 'coordinate-navigation'].sceneTypes);
  if (o.scenes.length === 0) problems.push('The outline has no scenes.');
  if (o.scenes.length > 24) problems.push('Use at most 24 scenes.');
  const keys = new Set<string>();
  for (const s of o.scenes) {
    if (keys.has(s.key)) problems.push(`Duplicate scene key ${s.key}.`);
    keys.add(s.key);
    if (!allowed.has(s.sceneType)) problems.push(`Scene ${s.key} uses scene type "${s.sceneType}", which is not allowed for the chosen interaction (${[...allowed].join(', ')}).`);
    for (const id of s.sourceSlideIds) if (!included.has(id)) problems.push(`Scene ${s.key} cites unknown or excluded slide "${id}".`);
    if (s.sourceSlideIds.length === 0 && !s.addedPractice) problems.push(`Scene ${s.key} needs sourceSlideIds or addedPractice=true.`);
    if (s.addedPractice && !brief.options.allowAddedPractice) problems.push(`Scene ${s.key} is added practice, but the creator did not allow added practice.`);
  }
  for (const o2 of o.learningOutcomes) {
    for (const id of o2.sourceSlideIds) if (!included.has(id)) problems.push(`An outcome cites unknown or excluded slide "${id}".`);
    if (o2.sourceSlideIds.length === 0 && !o2.addedPractice) problems.push('Every outcome needs sourceSlideIds or addedPractice=true.');
  }
  const needKeys = new Set(o.assetNeeds.map((n) => n.key));
  for (const s of o.scenes) {
    for (const k of [s.backgroundNeedKey, s.characterNeedKey]) if (k && !needKeys.has(k)) problems.push(`Scene ${s.key} refers to unknown asset need "${k}".`);
  }
  return problems;
}

function detailProblems(d: AiSceneDetail, expectedType: string, seed: number): string[] {
  const problems: string[] = [];
  if (d.interaction.type !== expectedType) problems.push(`Scene ${d.key}: interaction type must be "${expectedType}", got "${d.interaction.type}".`);
  if (d.hints.length < 1 || d.hints.length > 3) problems.push(`Scene ${d.key}: provide 1–3 hints.`);
  for (const issue of checkInteraction(d.interaction, { seed, sceneId: d.key })) {
    if (issue.severity === 'error') problems.push(`Scene ${d.key}: ${issue.message}`);
  }
  return problems;
}

/** Keep scenes in source order when the creator asked to preserve it (logged, never silent). */
function enforceSourceOrder(o: AiOutline, slideNumber: Map<string, number>): { outline: AiOutline; changed: boolean } {
  const firstSlide = (s: AiOutline['scenes'][number]) => Math.min(...s.sourceSlideIds.map((id) => slideNumber.get(id) ?? Infinity));
  let last = -Infinity;
  let ordered = true;
  for (const s of o.scenes) {
    if (s.addedPractice) continue;
    const n = firstSlide(s);
    if (n < last) ordered = false;
    last = Math.max(last, n);
  }
  if (ordered) return { outline: o, changed: false };
  const keyed = o.scenes.map((s, i) => ({ s, i, n: s.addedPractice ? null : firstSlide(s) }));
  const sourced = keyed.filter((k) => k.n !== null).sort((a, b) => a.n! - b.n! || a.i - b.i);
  const result: typeof keyed = [];
  let si = 0;
  for (const k of keyed) result.push(k.n === null ? k : sourced[si++]!);
  return { outline: { ...o, scenes: result.map((k) => k.s) }, changed: true };
}

export function assembleBlueprint(
  outline: AiOutline,
  details: Map<string, AiSceneDetail>,
  ctx: { brief: GameBrief; slides: SourceSlide[]; assetIds: Set<string>; origin: 'claude' | 'creator' },
): { blueprint: Blueprint; notes: string[] } {
  const notes: string[] = [];
  const lockedSlides = new Set(ctx.slides.filter((s) => s.lockedWording).map((s) => s.id));
  const needId = (key: string) => key.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '').slice(0, 32) || 'need';
  const assetNeeds = outline.assetNeeds.slice(0, 16).map((n) => {
    let assigned = n.assignedAssetId;
    if (assigned && !ctx.assetIds.has(assigned)) {
      notes.push(`Ignored unknown asset id ${assigned} for “${n.description}”.`);
      assigned = null;
    }
    return { id: needId(n.key), role: n.role, description: clip(n.description, 160) || 'Asset', assignedAssetId: assigned, required: n.required };
  });
  const needByKey = new Map(outline.assetNeeds.map((n) => [n.key, needId(n.key)]));
  const sceneIds = new Map(outline.scenes.map((s) => [s.key, newId(ID_PREFIX.scene)]));
  const scenes: BlueprintScene[] = outline.scenes.map((s, i) => {
    const d = details.get(s.key)!;
    return {
      id: sceneIds.get(s.key)!,
      title: clip(s.title, 60) || `Scene ${i + 1}`,
      pattern: s.pattern,
      sourceSlideIds: [...new Set(s.sourceSlideIds)],
      addedPractice: s.addedPractice,
      objective: clip(s.objective, 240) || 'See scene details.',
      visibleContent: clip(d.visibleContent, 400) || '—',
      learnerAction: clip(s.learnerAction, 240) || '—',
      expectedResult: clip(s.expectedResult, 240) || '—',
      instruction: clip(d.instruction, 220) || s.title,
      interaction: d.interaction,
      successFeedback: clip(d.successFeedback, 160) || 'Well done!',
      errorFeedback: clip(d.errorFeedback, 200) || 'Not quite — check your answer and try again.',
      hints: d.hints.slice(0, 3).map((h) => clip(h, 160)).filter(Boolean),
      next: null,
      assetNeedIds: {
        background: s.backgroundNeedKey ? (needByKey.get(s.backgroundNeedKey) ?? null) : null,
        character: s.characterNeedKey ? (needByKey.get(s.characterNeedKey) ?? null) : null,
      },
      completion: clip(d.completion, 240) || 'The scene rule is satisfied.',
      difficulty: s.difficulty,
      locks: { ...NO_LOCKS, sequence: ctx.brief.options.preserveSequence, wording: s.sourceSlideIds.some((id) => lockedSlides.has(id)) },
      origin: ctx.origin,
    };
  });
  for (const s of scenes) if (s.hints.length === 0) s.hints = ['Look back at the instruction and try again.'];
  scenes.forEach((s, i) => (s.next = scenes[i + 1]?.id ?? null));
  const blueprint: Blueprint = {
    schemaVersion: 1,
    title: clip(outline.title, 80) || 'Untitled game',
    learningOutcomes: outline.learningOutcomes.slice(0, 8).map((o, i) => ({ id: `out-${i + 1}`, text: clip(o.text, 240), sourceSlideIds: [...new Set(o.sourceSlideIds)], addedPractice: o.addedPractice })),
    coreMechanic: ctx.brief.mechanic ?? 'coordinate-navigation',
    customMechanicDescription: ctx.brief.mechanic === 'custom' ? clip(ctx.brief.customIdea, 1000) : null,
    premise: clip(outline.premise, 400) || '—',
    progression: clip(outline.progression, 400) || '—',
    assessment: clip(outline.assessment, 400) || '—',
    assetNeeds,
    accessibility: outline.accessibility.slice(0, 10).map((a) => clip(a, 200)).filter(Boolean),
    unresolvedDecisions: outline.unresolvedDecisions.slice(0, 10).map((u, i) => ({ id: `dec-${i + 1}`, question: clip(u.question, 240), options: u.options.slice(0, 5).map((o) => clip(o, 120)) })),
    assumptions: outline.assumptions.slice(0, 10).map((a) => clip(a, 240)).filter(Boolean),
    mechanicFit: clip(outline.mechanicFit, 500) || '—',
    scenes,
  };
  return { blueprint, notes };
}

export async function handleBlueprint(ctx: JobContext<'blueprint'>) {
  const { app } = ctx;
  const input = ctx.input();
  const project = getProjectRow(app.db, ctx.projectId);
  const brief = projectBrief(project);
  const slides = listSlides(app.db, ctx.projectId).filter((s) => s.included);
  const included = new Set(slides.map((s) => s.id));
  const { snapshot, revision } = currentSnapshot(app.db, ctx.projectId);
  const analysisRec = input.analysisId ? getAnalysis(app.db, input.analysisId) : currentAnalysis(app.db, ctx.projectId);

  if (ctx.mode === 'demo') {
    ctx.stage('demo', 'Demo mode — sample content');
    ctx.event('info', 'Demo mode — sample content: no Claude call is made. Loading the prepared blueprint for the bundled sample deck.');
    let blueprint: Blueprint;
    try {
      blueprint = await loadSampleBlueprint(app, ctx.projectId);
    } catch (err) {
      throw new JobFailure(`The prepared sample blueprint no longer matches this project (${(err as Error).message}).`, 'demo_mismatch', false);
    }
    const errors = checkBlueprint(blueprint, included).filter((i) => i.severity === 'error');
    if (errors.length > 0) throw new JobFailure(`The prepared sample blueprint refers to excluded slides (${errors[0]!.message}). Re-include them or configure Claude.`, 'demo_mismatch', false);
    const rev = insertBlueprintRevision(app.db, { projectId: ctx.projectId, parentId: null, origin: 'demo', model: null, jobId: ctx.jobId, analysisId: analysisRec?.id ?? null, sourceRevision: revision, snapshot, blueprint });
    return { blueprintRevisionId: rev.id, number: rev.number, demo: true };
  }

  if (!analysisRec) throw new JobFailure('Analyze the deck before generating a blueprint (Source → Analyze with Claude).', 'no_analysis', false);
  if (analysisRec.stale) ctx.event('warning', `The learning map is stale: ${analysisRec.staleReason ?? 'source changed'}. The blueprint will use the current slide text.`);
  if (slides.length === 0) throw new JobFailure('No slides are included.', 'no_slides', false);
  const seedBase = Date.now() & 0x7fffffff;
  const assetIds = new Set(listAssetRows(app.db, ctx.projectId).map((a) => a.id));
  const slideNumber = new Map(slides.map((s) => [s.id, s.slideNumber]));
  const context = [
    briefBlock(brief),
    allowedMechanicsNote(brief),
    analysisSummaryBlock(analysisRec.analysis),
    `Slide list (cite these ids exactly):\n${slideIndex(slides)}`,
    assetCatalog(app, ctx.projectId),
    sourceMaterial(app, slides, brief),
  ].join('\n\n');

  let outline = await ctx.once<AiOutline>('outline', 'Drafting the blueprint outline', async () => {
    let previous: string | null = null;
    let problems: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const text: string = previous
        ? `${context}\n\nYour previous outline:\n${previous}\n\nProblems to fix:\n- ${problems.join('\n- ')}\nReturn a corrected outline.`
        : `${context}\n\nDesign the blueprint outline.`;
      const r: StructuredResult<AiOutline> = await app.gateway.structured({ system: OUTLINE_SYSTEM, content: text, schema: aiOutlineSchema, maxTokens: 16000, effort: 'high', cacheSystem: true }, ctx.claude('blueprint-outline'));
      const usage = ctx.recordCall(r);
      problems = outlineProblems(r.data, brief, included);
      if (problems.length === 0) return { output: r.data, usage };
      if (attempt >= app.config.claude.maxRepairAttempts) {
        throw new JobFailure(`The blueprint outline did not pass validation (${problems.slice(0, 3).join('; ')}). Nothing was saved. Retry the stage.`, 'invalid_outline', true);
      }
      ctx.event('warning', `Outline validation found ${problems.length} problem(s): ${problems.slice(0, 2).join('; ')}. Asking Claude to correct them.`);
      previous = r.rawText.slice(0, 20_000);
    }
  });
  if (brief.options.preserveSequence) {
    const enforced = enforceSourceOrder(outline, slideNumber);
    if (enforced.changed) {
      outline = enforced.outline;
      ctx.event('warning', 'Claude proposed scenes out of source order; they were reordered to follow the slides because “Preserve source sequence” is on.');
    }
  }

  const details = new Map<string, AiSceneDetail>();
  const BATCH = 3;
  for (let i = 0; i < outline.scenes.length; i += BATCH) {
    const batch = outline.scenes.slice(i, i + BATCH);
    const label = `Writing scenes ${i + 1}–${i + batch.length} of ${outline.scenes.length}`;
    const out = await ctx.once<AiSceneDetail[]>(`scenes:${i / BATCH}`, label, async () => {
      const request = `${context}\n\nBlueprint outline:\n${JSON.stringify({ title: outline.title, premise: outline.premise, scenes: outline.scenes.map((s) => ({ key: s.key, title: s.title, pattern: s.pattern, sceneType: s.sceneType, sourceSlideIds: s.sourceSlideIds })) })}\n\nWrite the full details for these scenes (same keys, same scene types):\n${JSON.stringify(batch)}`;
      let previous: string | null = null;
      let problems: string[] = [];
      for (let attempt = 0; ; attempt++) {
        const text: string = previous ? `${request}\n\nYour previous answer:\n${previous}\n\nProblems to fix:\n- ${problems.join('\n- ')}\nReturn corrected scenes.` : request;
        const r: StructuredResult<{ scenes: AiSceneDetail[] }> = await app.gateway.structured({ system: SCENES_SYSTEM, content: text, schema: aiSceneBatchSchema, maxTokens: 16000, effort: 'medium', cacheSystem: true }, ctx.claude('blueprint-scenes'));
        const usage = ctx.recordCall(r);
        const byKey = new Map(r.data.scenes.map((d) => [d.key, d]));
        problems = [];
        for (const s of batch) {
          const d = byKey.get(s.key);
          if (!d) problems.push(`Missing details for scene ${s.key}.`);
          else problems.push(...detailProblems(d, s.sceneType, seedBase));
        }
        if (problems.length === 0) return { output: batch.map((s) => byKey.get(s.key)!), usage };
        if (attempt >= app.config.claude.maxRepairAttempts) {
          throw new JobFailure(`Scene details did not pass validation (${problems.slice(0, 3).join('; ')}). Completed scenes are kept; retry to continue from this batch.`, 'invalid_scenes', true);
        }
        ctx.event('warning', `Scene validation found ${problems.length} problem(s): ${problems.slice(0, 2).join('; ')}. Asking Claude to correct them.`);
        previous = r.rawText.slice(0, 20_000);
      }
    });
    for (const d of out) details.set(d.key, d);
  }

  ctx.stage('validate', 'Validating scene configuration');
  const { blueprint, notes } = assembleBlueprint(outline, details, { brief, slides, assetIds, origin: 'claude' });
  for (const n of notes) ctx.event('warning', n);
  const parsed = blueprintSchema.safeParse(blueprint);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new JobFailure(`The assembled blueprint is invalid (${issue ? `${issue.path.join('.')}: ${issue.message}` : 'schema'}). Nothing was saved.`, 'invalid_blueprint', true);
  }
  const issues = checkBlueprint(parsed.data, included);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw new JobFailure(`The blueprint has ${errors.length} problem(s): ${errors[0]!.message}. Nothing was saved.`, 'invalid_blueprint', true);
  for (const w of issues.filter((i) => i.severity === 'warning')) ctx.event('warning', w.message);

  ctx.stage('save', 'Saving blueprint draft');
  const rev = insertBlueprintRevision(app.db, {
    projectId: ctx.projectId,
    parentId: null,
    origin: 'claude',
    model: ctx.modelUsed,
    jobId: ctx.jobId,
    analysisId: analysisRec.id,
    sourceRevision: revision,
    snapshot,
    blueprint: parsed.data,
  });
  ctx.event('info', `Blueprint draft r${rev.number} saved with ${parsed.data.scenes.length} scenes. Review it, then approve it to build.`);
  return { blueprintRevisionId: rev.id, number: rev.number, model: ctx.modelUsed };
}
