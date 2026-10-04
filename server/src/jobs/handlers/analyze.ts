import { checkAnalysisReferences, learningAnalysisSchema, type LearningAnalysis } from '@shared/schemas/analysis.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { aiAnalysisSchema, slideDigestBatchSchema, type AiAnalysis, type SlideDigest } from '../../claude/schemas.ts';
import type { StructuredResult } from '../../claude/gateway.ts';
import { ANALYSIS_SYSTEM, briefBlock, DIGEST_SYSTEM, digestBlock, slideBlock, slideIndex } from '../../claude/prompts.ts';
import { insertAnalysis } from '../../db/learning.ts';
import { getProjectRow, projectBrief } from '../../db/projects.ts';
import { currentSnapshot, effectiveHash, listSlides } from '../../db/sources.ts';
import { nowIso, parseJson } from '../../db/db.ts';
import { loadSampleAnalysis } from '../../demo/sample.ts';
import { JobFailure, type JobContext } from '../context.ts';
import { visualBlocks } from './visuals.ts';

const DIGEST_CHUNK = 8;
const DIRECT_LIMIT_CHARS = 40_000;
const DIRECT_LIMIT_SLIDES = 12;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const uniq = (a: string[]) => [...new Set(a)];

/** Convert Claude's output into the stored learning map: ids, limits, provenance. */
export function normalizeAnalysis(ai: AiAnalysis, slides: SourceSlide[]): { analysis: LearningAnalysis; clipped: number } {
  let clipped = 0;
  const c = (s: string, n: number) => {
    if (s.length > n) clipped++;
    return clip(s.trim(), n);
  };
  const required = new Set(slides.filter((s) => s.requiredExample).map((s) => s.id));
  const analysis: LearningAnalysis = {
    schemaVersion: 1,
    topic: c(ai.topic, 120) || 'Untitled topic',
    summary: c(ai.summary, 600),
    concepts: ai.concepts.slice(0, 20).map((x, i) => ({ id: `cpt-${i + 1}`, name: c(x.name, 80), description: c(x.description, 300), sourceSlideIds: uniq(x.sourceSlideIds) })),
    prerequisites: ai.prerequisites.slice(0, 10).map((x, i) => ({ id: `pre-${i + 1}`, text: c(x.text, 200), sourceSlideIds: uniq(x.sourceSlideIds), inferred: true })),
    objectives: ai.objectives.slice(0, 12).map((x, i) => ({
      id: `obj-${i + 1}`,
      text: c(x.text, 240),
      sourceSlideIds: uniq(x.sourceSlideIds),
      addedPractice: x.addedPractice,
      status: 'proposed' as const,
      origin: 'claude' as const,
      locked: false,
    })),
    examples: ai.examples.slice(0, 20).map((x, i) => ({ id: `ex-${i + 1}`, text: c(x.text, 300), sourceSlideIds: uniq(x.sourceSlideIds), required: x.sourceSlideIds.some((id) => required.has(id)) })),
    questions: ai.questions.slice(0, 20).map((x, i) => ({ id: `q-${i + 1}`, prompt: c(x.prompt, 240), answer: c(x.answer, 200), sourceSlideIds: uniq(x.sourceSlideIds), addedPractice: x.addedPractice })),
    interactions: ai.interactions.slice(0, 12).map((x, i) => ({ id: `int-${i + 1}`, mechanic: x.mechanic, description: c(x.description, 300), sourceSlideIds: uniq(x.sourceSlideIds), addedPractice: x.addedPractice })),
    openQuestions: ai.openQuestions.slice(0, 10).map((q) => c(q, 240)),
  };
  return { analysis, clipped };
}

function digestKey(slide: SourceSlide, includeNotes: boolean): string {
  return `${effectiveHash(slide)}:${includeNotes ? 'notes' : 'no-notes'}`;
}

export async function handleAnalyze(ctx: JobContext<'analyze'>) {
  const { app } = ctx;
  const project = getProjectRow(app.db, ctx.projectId);
  const brief = projectBrief(project);
  const slides = listSlides(app.db, ctx.projectId).filter((s) => s.included);
  if (slides.length === 0) throw new JobFailure('No slides are included. Include at least one slide in Source review.', 'no_slides', false);
  const { snapshot, revision } = currentSnapshot(app.db, ctx.projectId);
  const includedIds = new Set(slides.map((s) => s.id));

  if (ctx.mode === 'demo') {
    ctx.stage('demo', 'Demo mode — sample content');
    ctx.event('info', 'Demo mode — sample content: no Claude call is made. Loading the prepared learning map for the bundled sample deck.');
    let analysis: LearningAnalysis;
    try {
      analysis = await loadSampleAnalysis(app, ctx.projectId);
    } catch (err) {
      throw new JobFailure(`The prepared sample analysis no longer matches this project's slides (${(err as Error).message}). Configure Claude to analyze edited content.`, 'demo_mismatch', false);
    }
    const issues = checkAnalysisReferences(analysis, includedIds);
    if (issues.length > 0) {
      throw new JobFailure(`The prepared sample analysis refers to slides that are now excluded (${issues[0]!.message}). Re-include them, or configure Claude to analyze edited content.`, 'demo_mismatch', false);
    }
    const rec = insertAnalysis(app.db, { projectId: ctx.projectId, origin: 'demo', model: null, jobId: ctx.jobId, sourceRevision: revision, snapshot, briefRevision: project.brief_revision, analysis });
    return { analysisId: rec.id, demo: true };
  }

  const includeNotes = brief.aiInputs.includeSpeakerNotes;
  ctx.stage('prepare', `Preparing ${slides.length} included slide${slides.length === 1 ? '' : 's'}`);
  ctx.event('info', `Sending the text of ${slides.length} slide(s)${includeNotes ? ' including speaker notes' : ' without speaker notes'}. Hidden or excluded slides are not sent.`);
  const visuals = await visualBlocks(app, slides, brief, (m) => ctx.event('info', m));

  const fullBlocks = slides.map((s) => slideBlock(s, { includeNotes }));
  const totalChars = fullBlocks.reduce((n, b) => n + b.length, 0);
  let sourceText: string;
  if (slides.length > DIRECT_LIMIT_SLIDES || totalChars > DIRECT_LIMIT_CHARS) {
    const digests = new Map<string, SlideDigest>();
    for (let i = 0; i < slides.length; i += DIGEST_CHUNK) {
      const chunk = slides.slice(i, i + DIGEST_CHUNK);
      const label = `Reading slides ${chunk[0]!.slideNumber}–${chunk[chunk.length - 1]!.slideNumber}`;
      const out = await ctx.once<SlideDigest[]>(`digest:${i / DIGEST_CHUNK}`, label, async () => {
        const model = app.gateway.resolveModel().model ?? '';
        const cached: SlideDigest[] = [];
        const missing: SourceSlide[] = [];
        for (const s of chunk) {
          const row = app.db.get<{ digest_json: string }>('SELECT digest_json FROM slide_digests WHERE slide_id = ? AND content_hash = ? AND model = ?', [s.id, digestKey(s, includeNotes), model]);
          if (row) cached.push(parseJson<SlideDigest>(row.digest_json, null as unknown as SlideDigest));
          else missing.push(s);
        }
        if (missing.length === 0) {
          ctx.event('info', `Reusing saved summaries for slides ${chunk[0]!.slideNumber}–${chunk[chunk.length - 1]!.slideNumber} (unchanged since the last analysis).`);
          return { output: cached };
        }
        const chunkVisuals = await visualBlocks(app, missing, brief, () => {});
        const r = await app.gateway.structured(
          {
            system: DIGEST_SYSTEM,
            content: [...chunkVisuals, { type: 'text', text: `Summarize these ${missing.length} slides. Return one entry per slide id, in order.\n\n${missing.map((s) => slideBlock(s, { includeNotes })).join('\n\n')}` }],
            schema: slideDigestBatchSchema,
            maxTokens: 8000,
            effort: 'low',
            cacheSystem: true,
          },
          ctx.claude('digest'),
        );
        const usage = ctx.recordCall(r);
        const got = new Map(r.data.slides.map((d) => [d.slideId, d]));
        const absent = missing.filter((s) => !got.has(s.id));
        if (absent.length > 0) throw new JobFailure(`Claude did not summarize slide(s) ${absent.map((s) => s.slideNumber).join(', ')}. Retry this stage.`, 'digest_incomplete', true);
        for (const s of missing) {
          app.db.run(
            'INSERT OR REPLACE INTO slide_digests (slide_id, content_hash, model, digest_json, created_at) VALUES (?, ?, ?, ?, ?)',
            [s.id, digestKey(s, includeNotes), r.model, JSON.stringify(got.get(s.id)), nowIso()],
          );
        }
        return { output: [...cached, ...missing.map((s) => got.get(s.id)!)], usage };
      });
      for (const d of out) digests.set(d.slideId, d);
    }
    sourceText = slides.map((s) => (digests.has(s.id) ? digestBlock(s, digests.get(s.id)!) : slideBlock(s, { includeNotes }))).join('\n\n');
  } else {
    ctx.event('info', `Reading slides ${slides[0]!.slideNumber}–${slides[slides.length - 1]!.slideNumber}`);
    sourceText = fullBlocks.join('\n\n');
  }

  const analysis = await ctx.once<LearningAnalysis>('learning-map', 'Building the learning map', async () => {
    const base = `${briefBlock(brief)}\n\nSlide list (cite these ids exactly):\n${slideIndex(slides)}\n\n${sourceText}\n\nPropose the learning map for this deck.`;
    const maxRepairs = app.config.claude.maxRepairAttempts;
    let previous: string | null = null;
    let problems: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const text: string = previous ? `${base}\n\nYour previous answer was:\n${previous}\n\nIt had these problems:\n- ${problems.join('\n- ')}\nReturn a corrected learning map.` : base;
      const r: StructuredResult<AiAnalysis> = await app.gateway.structured(
        { system: ANALYSIS_SYSTEM, content: [...(slides.length <= DIRECT_LIMIT_SLIDES ? visuals : []), { type: 'text', text }], schema: aiAnalysisSchema, maxTokens: 16000, effort: 'medium', cacheSystem: true },
        ctx.claude('learning-map'),
      );
      const usage = ctx.recordCall(r);
      ctx.stage('validate', 'Validating source references');
      const { analysis: normalized, clipped } = normalizeAnalysis(r.data, slides);
      if (clipped > 0) ctx.event('info', `Shortened ${clipped} overlong field(s) to fit the learning map limits.`);
      const parsed = learningAnalysisSchema.safeParse(normalized);
      problems = [
        ...(parsed.success ? [] : parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`)),
        ...checkAnalysisReferences(normalized, includedIds).map((i) => `${i.path}: ${i.message}`),
      ];
      if (problems.length === 0 && parsed.success) return { output: parsed.data, usage };
      if (attempt >= maxRepairs) {
        throw new JobFailure(`Claude's learning map did not pass validation (${problems.slice(0, 3).join('; ')}). Nothing was saved. Retry the stage.`, 'invalid_analysis', true);
      }
      ctx.event('warning', `Validation found ${problems.length} problem(s): ${problems.slice(0, 2).join('; ')}. Asking Claude to correct them (attempt ${attempt + 1} of ${maxRepairs}).`);
      previous = r.rawText.slice(0, 20_000);
    }
  });

  ctx.stage('save', 'Saving the learning map');
  const rec = insertAnalysis(app.db, {
    projectId: ctx.projectId,
    origin: 'claude',
    model: ctx.modelUsed,
    jobId: ctx.jobId,
    sourceRevision: revision,
    snapshot,
    briefRevision: project.brief_revision,
    analysis,
  });
  ctx.event('info', `Learning map saved: ${analysis.objectives.length} proposed objectives, ${analysis.concepts.length} concepts. Review them in Source → Learning map.`);
  return { analysisId: rec.id, model: ctx.modelUsed, fellBack: ctx.fellBack };
}
