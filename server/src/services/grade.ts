import { blueprintSchema, type Blueprint } from '@shared/schemas/blueprint.ts';
import type { GameConfig } from '@shared/schemas/game.ts';
import { adaptationItemSchema, gradeLabel, type AdaptationItem, type GradeAdaptationPlan, type GradePlanRecord, type GradeProfile } from '@shared/schemas/grade.ts';
import { applyChangeOps } from '@shared/schemas/proposal.ts';
import type { GameVersion, Proposal } from '@shared/schemas/records.ts';
import { gradePlanOps } from '@shared/plans.ts';
import type { App } from '../app.ts';
import type { AiGradePlan } from '../claude/schemas.ts';
import { slideBlock } from '../claude/prompts.ts';
import { getGradePlan, resolveGradePlan } from '../db/grade.ts';
import { approvedBlueprint, getBlueprintSnapshot, insertBlueprintRevision } from '../db/learning.ts';
import { listSlides } from '../db/sources.ts';
import { getVersion, insertProposal } from '../db/versions.ts';
import { badRequest, conflict } from '../errors.ts';
import { applyProposal } from './proposals.ts';

export function gradeContext(app: App, projectId: string, config: GameConfig, profile: GradeProfile, fromGrade: string | null, mode: 'presentation' | 'challenge'): string {
  const scenes = config.scenes.map((s) => ({
    id: s.id,
    title: s.title,
    type: s.interaction.type,
    instruction: s.instruction,
    supportText: s.supportText,
    feedback: s.feedback,
    layout: s.layout,
    wordingLocked: s.locks.wording,
    sourceSlideIds: s.sourceSlideIds,
    addedPractice: s.addedPractice,
    interaction: s.interaction,
  }));
  const slideIds = new Set(config.scenes.flatMap((s) => s.sourceSlideIds));
  const slides = listSlides(app.db, projectId).filter((s) => slideIds.has(s.id));
  return [
    `Mode: ${mode}.`,
    `Built for: ${fromGrade ?? 'no grade recorded'}. Target profile: ${gradeLabel(profile)}.`,
    `<grade_profile>\n${JSON.stringify({ ...profile, label: gradeLabel(profile) })}\n</grade_profile>`,
    `<scene_config>\n${JSON.stringify(scenes)}\n</scene_config>`,
    slides.length ? `Source slides:\n${slides.map((s) => slideBlock(s, { includeNotes: false })).join('\n\n')}` : 'No source slides are linked (creator-written content).',
  ].join('\n\n');
}

/** Validate Claude's items against the real scenes, fields, locks and the plan mode. */
export function normalizeAiGrade(config: GameConfig, ai: AiGradePlan, mode: 'presentation' | 'challenge'): GradeAdaptationPlan {
  const assumptions = ai.assumptions.slice(0, 8).map((a) => a.slice(0, 240)).filter(Boolean);
  const items: AdaptationItem[] = [];
  ai.items.slice(0, 40).forEach((raw, i) => {
    const scene = raw.sceneId ? config.scenes.find((s) => s.id === raw.sceneId) : null;
    if (raw.sceneId && !scene) return;
    let change: AdaptationItem['change'] = null;
    if (raw.field && !(raw.changesLearning && mode === 'presentation')) {
      const value =
        raw.field === 'feedback.hints'
          ? (raw.valueHints ?? []).map((h) => h.slice(0, 160)).filter(Boolean).slice(0, 3)
          : raw.field === 'layout.showProgress'
            ? raw.valueBool
            : raw.field === 'layout.density'
              ? raw.valueDensity
              : raw.valueText?.trim().slice(0, raw.field === 'title' ? 60 : raw.field === 'instruction' ? 300 : 400);
      const wording = !raw.field.startsWith('layout.');
      if (value === null || value === undefined || (Array.isArray(value) && value.length === 0) || value === '') return;
      if (wording && !scene) return;
      if (wording && scene?.locks.wording) {
        if (assumptions.length < 10) assumptions.push(`“${scene.title}” has its wording locked to the source, so its ${raw.field} was not changed.`);
        return;
      }
      change = { field: raw.field, value } as AdaptationItem['change'];
    }
    const item = {
      id: `item-${i + 1}`,
      area: raw.area,
      sceneId: scene?.id ?? null,
      change,
      summary: raw.summary.slice(0, 300) || 'Change',
      rationale: raw.rationale.slice(0, 400) || 'For the target profile.',
      sourceSlideIds: raw.sourceSlideIds.filter((id) => config.scenes.some((s) => s.sourceSlideIds.includes(id))).slice(0, 10),
      addedPractice: raw.addedPractice,
      changesLearning: raw.changesLearning,
    };
    const parsed = adaptationItemSchema.safeParse(item);
    if (parsed.success) items.push(parsed.data);
  });
  return {
    summary: (ai.summary || 'Grade adaptation plan').slice(0, 800),
    items,
    motionPurpose: (ai.motionPurpose || 'Motion only where it explains something.').slice(0, 500),
    assumptions: assumptions.slice(0, 10),
    curriculumNote: (ai.curriculumNote || 'Curriculum alignment is not verified.').slice(0, 300),
  };
}

/** Field of a presentation change → the blueprint scene field it corresponds to. */
const BLUEPRINT_FIELD: Partial<Record<string, 'title' | 'instruction' | 'successFeedback' | 'errorFeedback' | 'hints'>> = {
  title: 'title',
  instruction: 'instruction',
  'feedback.success': 'successFeedback',
  'feedback.error': 'errorFeedback',
  'feedback.hints': 'hints',
};

/**
 * Apply the accepted items. Presentation-only: a new game version (through
 * the proposal system, with locks and validation). Learning challenge: a new
 * draft blueprint carrying the accepted wording and the learning changes as
 * open decisions, for instructional review and approval before any build.
 */
export function applyGradePlan(app: App, planId: string): { plan: GradePlanRecord; version: GameVersion | null; proposal: Proposal | null; blueprintRevisionId: string | null; notes: string[] } {
  const plan = getGradePlan(app.db, planId);
  if (plan.status !== 'proposed') throw conflict(`This plan is already ${plan.status}.`);
  if (!plan.baseVersionId) throw conflict('This plan is staged for the next build.', 'Use “Approve & build” in Prepare to build it in.');
  const accepted = plan.plan.items.filter((i) => plan.decisions[i.id] === 'accepted');
  if (accepted.length === 0) throw badRequest('Accept at least one item before applying.');
  const base = getVersion(app.db, plan.baseVersionId);

  if (plan.mode === 'challenge') {
    const approved = approvedBlueprint(app.db, plan.projectId, plan.branchId);
    if (!approved) throw conflict('There is no approved blueprint to start the review from.');
    const bp: Blueprint = structuredClone(approved.blueprint);
    const notes: string[] = [];
    for (const item of accepted) {
      if (item.change && item.sceneId && BLUEPRINT_FIELD[item.change.field]) {
        const scene = bp.scenes.find((s) => s.id === item.sceneId);
        if (scene) (scene as Record<string, unknown>)[BLUEPRINT_FIELD[item.change.field]!] = item.change.value;
      } else if (item.change) {
        notes.push(`“${item.summary}” applies to the built game and is kept for after approval.`);
      }
    }
    const learning = accepted.filter((i) => i.changesLearning);
    bp.unresolvedDecisions = [
      ...bp.unresolvedDecisions,
      ...learning.map((i, k) => ({ id: `grade-${plan.number}-${k + 1}`, question: `${plan.toGrade} plan: ${i.summary}`.slice(0, 240), options: ['Make this change in the scene editor', 'Leave as is'] })),
    ].slice(0, 10);
    const parsed = blueprintSchema.safeParse(bp);
    if (!parsed.success) throw badRequest('The accepted items do not fit the blueprint.', parsed.error.issues[0]?.message);
    const draft = insertBlueprintRevision(app.db, {
      projectId: plan.projectId,
      parentId: approved.id,
      origin: plan.origin === 'claude' ? 'claude' : 'creator',
      model: plan.model,
      jobId: null,
      analysisId: approved.analysisId,
      sourceRevision: approved.sourceRevision,
      snapshot: getBlueprintSnapshot(app.db, approved.id),
      blueprint: parsed.data,
      branchId: plan.branchId,
    });
    resolveGradePlan(app.db, plan.id, 'applied', { blueprintRevisionId: draft.id });
    return { plan: getGradePlan(app.db, plan.id), version: null, proposal: null, blueprintRevisionId: draft.id, notes: [...notes, `${learning.length} learning change(s) are listed as open decisions in blueprint r${draft.number} for review.`] };
  }

  const { ops, notes } = gradePlanOps(plan.plan, plan.decisions, base.config);
  if (ops.length === 0) throw badRequest('None of the accepted items is a concrete change.', notes[0]);
  const preview = applyChangeOps(base.config, ops, { scope: { kind: 'project', sceneId: null } });
  const proposal = insertProposal(app.db, {
    projectId: plan.projectId,
    baseVersionId: base.id,
    scope: { kind: 'project', sceneId: null },
    request: `Grade adaptation plan ${plan.number} for ${plan.toGrade}`,
    summary: `Grade plan ${plan.number} (${plan.toGrade}): ${ops.length} change(s)`,
    explanation: plan.plan.summary,
    ops,
    results: preview.results,
    origin: plan.origin === 'claude' ? 'claude' : plan.origin === 'demo' ? 'demo' : 'creator',
    model: plan.model,
    jobId: null,
  });
  try {
    const r = applyProposal(app, proposal.id);
    resolveGradePlan(app.db, plan.id, 'applied', { proposalId: proposal.id, resultVersionId: r.version.id });
    return { plan: getGradePlan(app.db, plan.id), version: r.version, proposal: r.proposal, blueprintRevisionId: null, notes };
  } catch (err) {
    if ((err as { status?: number }).status === 409 && /version/.test((err as Error).message)) resolveGradePlan(app.db, plan.id, 'stale', { proposalId: proposal.id });
    throw err;
  }
}
