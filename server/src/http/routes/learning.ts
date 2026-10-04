import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { checkInteraction } from '@shared/attainability.ts';
import { learningAnalysisSchema } from '@shared/schemas/analysis.ts';
import { blueprintSchema, checkBlueprint, NO_LOCKS, NOT_WRITTEN, type Blueprint, type BlueprintScene } from '@shared/schemas/blueprint.ts';
import { effectiveSlideText } from '@shared/schemas/source.ts';
import { computeCoverage } from '@shared/coverage.ts';
import { isBuildableSceneType } from '@shared/registry.ts';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import type { App } from '../../app.ts';
import { approveBlueprint, createDraftFrom, currentAnalysis, getAnalysis, getBlueprintRevision, insertBlueprintRevision, latestBlueprint, listBlueprintRevisions, updateAnalysisContent, updateDraftBlueprint } from '../../db/learning.ts';
import { getProjectRow, projectBrief, touchProject } from '../../db/projects.ts';
import { currentSnapshot, listSlides } from '../../db/sources.ts';
import { badRequest, notFound } from '../../errors.ts';
import { parse } from '../util.ts';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function blueprintIssues(app: App, projectId: string, blueprint: Blueprint) {
  const included = new Set(listSlides(app.db, projectId).filter((s) => s.included).map((s) => s.id));
  const structural = checkBlueprint(blueprint, included);
  const scenes = blueprint.scenes.map((s) => ({
    sceneId: s.id,
    buildable: isBuildableSceneType(s.interaction.type),
    issues: checkInteraction(s.interaction, { seed: 1, sceneId: s.id }),
  }));
  return { structural, scenes };
}

export function learningRoutes(f: FastifyInstance, app: App): void {
  f.get('/api/projects/:id/analysis', async (req) => {
    const { id } = req.params as { id: string };
    return { analysis: currentAnalysis(app.db, id) };
  });

  f.put('/api/analyses/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ analysis: learningAnalysisSchema, revision: z.number().int() }), req.body);
    const rec = updateAnalysisContent(app.db, id, body.analysis, body.revision);
    touchProject(app.db, rec.projectId);
    return { analysis: rec };
  });

  f.get('/api/projects/:id/blueprints', async (req) => {
    const { id } = req.params as { id: string };
    return { revisions: listBlueprintRevisions(app.db, id) };
  });

  f.get('/api/blueprints/:id', async (req) => {
    const { id } = req.params as { id: string };
    const revision = getBlueprintRevision(app.db, id);
    return { revision, issues: blueprintIssues(app, revision.projectId, revision.blueprint) };
  });

  f.put('/api/blueprints/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ blueprint: blueprintSchema, revision: z.number().int(), acknowledgeSourceChanges: z.boolean().optional() }), req.body);
    const cur = getBlueprintRevision(app.db, id);
    const refresh = body.acknowledgeSourceChanges ? currentSnapshot(app.db, cur.projectId) : undefined;
    const revision = updateDraftBlueprint(app.db, id, body.blueprint, body.revision, refresh);
    touchProject(app.db, revision.projectId);
    return { revision, issues: blueprintIssues(app, revision.projectId, revision.blueprint) };
  });

  f.post('/api/blueprints/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ revision: z.number().int() }), req.body);
    const cur = getBlueprintRevision(app.db, id);
    const issues = blueprintIssues(app, cur.projectId, cur.blueprint);
    const blocking = issues.structural.filter((i) => i.severity === 'error');
    if (blocking.length > 0) throw badRequest(`Blueprint r${cur.number} has problems that block approval: ${blocking[0]!.message}`, 'Fix them in the editor, then approve.');
    const revision = approveBlueprint(app.db, id, body.revision);
    touchProject(app.db, revision.projectId);
    return { revision, issues };
  });

  /** New draft copied from any revision — editing an approved revision always goes through here. */
  f.post('/api/blueprints/:id/draft', async (req, reply) => {
    const { id } = req.params as { id: string };
    const src = getBlueprintRevision(app.db, id);
    const revision = createDraftFrom(app.db, id, currentSnapshot(app.db, src.projectId));
    touchProject(app.db, revision.projectId);
    return reply.code(201).send({ revision, issues: blueprintIssues(app, revision.projectId, revision.blueprint) });
  });

  /**
   * Creator-authored starting point (no AI): one concept card per included
   * slide, built from the slide's own extracted text. The creator then turns
   * cards into interactions in the editor.
   */
  f.post('/api/projects/:id/blueprints/manual', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = getProjectRow(app.db, id);
    const brief = projectBrief(project);
    const slides = listSlides(app.db, id).filter((s) => s.included);
    if (slides.length === 0) throw badRequest('Include at least one slide before starting a blueprint.');
    const analysis = currentAnalysis(app.db, id);
    const scenes: BlueprintScene[] = slides.slice(0, 24).map((s) => {
      const t = effectiveSlideText(s);
      const points = t.blocks
        .filter((b) => b.role !== 'title')
        .flatMap((b) => b.paragraphs)
        .map((p) => p.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 4)
        .map((p) => clip(p, 140));
      const title = clip(t.title || `Slide ${s.slideNumber}`, 60);
      return {
        id: newId(ID_PREFIX.scene),
        title,
        pattern: 'discover',
        sourceSlideIds: [s.id],
        addedPractice: false,
        objective: clip(`Understand: ${title}`, 240),
        visibleContent: clip(`Concept card with the key points from slide ${s.slideNumber}.`, 400),
        learnerAction: 'Read the card and continue.',
        expectedResult: 'The learner continues to the next scene.',
        instruction: title,
        interaction: { type: 'info', points: points.length ? points : [title], illustration: 'none', continueLabel: 'Continue' },
        successFeedback: 'Continue when you are ready.',
        errorFeedback: 'Read the card, then continue.',
        hints: ['Read each point, then continue.'],
        next: null,
        assetNeedIds: { background: null, character: null },
        completion: 'The learner selects Continue.',
        difficulty: 'gentle',
        locks: { ...NO_LOCKS, sequence: brief.options.preserveSequence, wording: s.lockedWording },
        origin: 'creator',
      };
    });
    scenes.forEach((s, i) => (s.next = scenes[i + 1]?.id ?? null));
    const outcomes = analysis?.analysis.objectives.length
      ? analysis.analysis.objectives.slice(0, 8).map((o, i) => ({ id: `out-${i + 1}`, text: o.text, sourceSlideIds: o.sourceSlideIds, addedPractice: o.addedPractice }))
      : [{ id: 'out-1', text: clip(brief.learningObjective || `Learn the content of “${project.name}”.`, 240), sourceSlideIds: slides.slice(0, 40).map((s) => s.id), addedPractice: false }];
    const blueprint: Blueprint = {
      schemaVersion: 1,
      title: clip(brief.title || project.name, 80),
      learningOutcomes: outcomes,
      coreMechanic: brief.mechanic ?? 'coordinate-navigation',
      customMechanicDescription: brief.mechanic === 'custom' ? clip(brief.customIdea, 1000) || null : null,
      premise: `${NOT_WRITTEN} — describe the story premise.`,
      progression: `${NOT_WRITTEN} — describe how support fades and difficulty grows.`,
      assessment: `${NOT_WRITTEN} — describe how understanding is checked.`,
      assetNeeds: [],
      accessibility: ['Every interaction must work with a keyboard and without dragging.'],
      unresolvedDecisions: [],
      assumptions: [],
      mechanicFit: `${NOT_WRITTEN} — explain why the chosen interaction fits this lesson.`,
      scenes,
    };
    const snap = currentSnapshot(app.db, id);
    const revision = insertBlueprintRevision(app.db, { projectId: id, parentId: latestBlueprint(app.db, id)?.id ?? null, origin: 'creator', model: null, jobId: null, analysisId: analysis?.id ?? null, sourceRevision: snap.revision, snapshot: snap.snapshot, blueprint });
    touchProject(app.db, id);
    return reply.code(201).send({ revision, issues: blueprintIssues(app, id, blueprint) });
  });

  f.get('/api/projects/:id/coverage', async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ blueprintId: z.string().optional() }), req.query, 'query');
    const rev = q.blueprintId ? getBlueprintRevision(app.db, q.blueprintId) : latestBlueprint(app.db, id);
    if (rev && rev.projectId !== id) throw notFound('Blueprint revision');
    const analysis = rev?.analysisId ? getAnalysis(app.db, rev.analysisId) : currentAnalysis(app.db, id);
    const slides = listSlides(app.db, id).map((s) => ({ id: s.id, slideNumber: s.slideNumber, hidden: s.hidden, included: s.included, title: effectiveSlideText(s).title }));
    return { coverage: computeCoverage(slides, rev?.blueprint ?? null, analysis?.analysis ?? null, rev?.id ?? null) };
  });
}
