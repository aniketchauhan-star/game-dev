import type Anthropic from '@anthropic-ai/sdk';
import { applyChangeOps, PROJECT_FIELDS, SCENE_FIELDS, type ChangeOp, type ChangeScope, type ProjectField, type SceneField } from '@shared/schemas/proposal.ts';
import type { GameConfig } from '@shared/schemas/game.ts';
import { PROPOSE_CHANGES_TOOL, proposeChangesInputSchema } from '../../claude/schemas.ts';
import { ASK_SYSTEM, analysisSummaryBlock, briefBlock, REFINE_SYSTEM, slideBlock } from '../../claude/prompts.ts';
import { getMessage, insertMessage, listMessages, updateMessage } from '../../db/misc.ts';
import { currentAnalysis } from '../../db/learning.ts';
import { getProjectRow, projectBrief } from '../../db/projects.ts';
import { getSlide, listSlides } from '../../db/sources.ts';
import { currentVersion, getVersion, insertProposal } from '../../db/versions.ts';
import { DEMO_TEMPLATES, matchDemoTemplate } from '../../demo/sample.ts';
import { JobFailure, type JobContext } from '../context.ts';
import { assetCatalog } from './blueprint.ts';

const SCENE_FIELD_SET = new Set<string>(SCENE_FIELDS);
const PROJECT_FIELD_SET = new Set<string>(PROJECT_FIELDS);

function conversationSummary(ctx: JobContext, excludeId: string): string {
  const recent = listMessages(ctx.app.db, ctx.projectId, 12)
    .filter((m) => m.id !== excludeId && m.role !== 'system' && m.status === 'complete')
    .slice(-6);
  if (recent.length === 0) return '';
  return `<conversation_summary>\n${recent.map((m) => `${m.role === 'creator' ? 'Creator' : 'Assistant'}: ${m.text.slice(0, 400)}`).join('\n')}\n</conversation_summary>`;
}

function configContext(config: GameConfig, scope: ChangeScope): string {
  const overview = {
    title: config.title,
    theme: { presetId: config.theme.presetId, paletteId: config.theme.paletteId, decor: config.theme.decor, fontStyle: config.theme.fontStyle, backgroundAssetId: config.theme.backgroundAssetId },
    settings: { minimalText: config.settings.minimalText, reducedMotion: config.settings.reducedMotion, locks: config.settings.locks, sfx: config.settings.audio.sfx },
    screens: config.screens,
    scenes: config.scenes.map((s, i) => ({ id: s.id, position: i, title: s.title, type: s.interaction.type, locks: s.locks })),
  };
  const scoped = scope.kind === 'scene' ? config.scenes.filter((s) => s.id === scope.sceneId) : config.scenes;
  return `<game_config>\n${JSON.stringify(overview)}\n</game_config>\n\n<scene_config>\n${JSON.stringify(scoped)}\n</scene_config>`;
}

/** Turn validated tool input into change ops. Unparseable values are kept as invalid ops so the creator sees them. */
export function toOps(changes: Array<{ op: string; sceneId: string | null; field: string | null; valueJson: string | null; toIndex: number | null }>): {
  ops: ChangeOp[];
  rejected: string[];
} {
  const ops: ChangeOp[] = [];
  const rejected: string[] = [];
  for (const c of changes) {
    if (c.op === 'move-scene') {
      if (c.sceneId && c.toIndex !== null) ops.push({ op: 'move-scene', sceneId: c.sceneId, toIndex: c.toIndex });
      else rejected.push('A scene move was missing its scene or position.');
      continue;
    }
    let value: unknown;
    try {
      value = c.valueJson === null ? null : JSON.parse(c.valueJson);
    } catch {
      rejected.push(`The value for ${c.field ?? 'a field'} was not valid JSON.`);
      continue;
    }
    if (c.op === 'set-scene-field') {
      if (!c.sceneId || !c.field || !SCENE_FIELD_SET.has(c.field)) {
        rejected.push(`“${c.field ?? '?'}” is not an editable scene field.`);
        continue;
      }
      ops.push({ op: 'set-scene-field', sceneId: c.sceneId, field: c.field as SceneField, value });
    } else if (c.op === 'set-project-field') {
      if (!c.field || !PROJECT_FIELD_SET.has(c.field)) {
        rejected.push(`“${c.field ?? '?'}” is not an editable project field.`);
        continue;
      }
      ops.push({ op: 'set-project-field', field: c.field as ProjectField, value });
    }
  }
  return { ops, rejected };
}

export async function handleRefine(ctx: JobContext<'refine'>) {
  const { app } = ctx;
  const { messageId, baseVersionId, scope, request } = ctx.input();
  const base = getVersion(app.db, baseVersionId);
  if (base.projectId !== ctx.projectId) throw new JobFailure('Version not found in this project.', 'not_found', false);
  const userMessage = getMessage(app.db, messageId);
  const reply = insertMessage(app.db, {
    projectId: ctx.projectId,
    role: 'claude',
    text: '',
    scope: userMessage.scope,
    area: 'build',
    origin: ctx.mode === 'demo' ? 'demo' : 'claude',
    status: 'streaming',
    jobId: ctx.jobId,
  });
  const current = currentVersion(app.db, ctx.projectId);
  if (current && current.id !== base.id) ctx.event('warning', `A newer version (v${current.number}) exists. This proposal targets v${base.number} and will be marked stale if applied.`);

  try {
    if (ctx.mode === 'demo') {
      ctx.stage('demo', 'Demo mode — sample content');
      const template = matchDemoTemplate(request);
      if (!template) {
        const text = `Without a Claude connection I can only replay prepared changes for these requests: ${DEMO_TEMPLATES.map((t) => `“${t.prompt}”`).join(', ')}. You can also edit any scene directly in the inspector.`;
        updateMessage(app.db, reply.id, { text, status: 'complete' });
        return { proposalId: null, demo: true };
      }
      const planned = template.plan(base.config, scope);
      if (!Array.isArray(planned)) {
        updateMessage(app.db, reply.id, { text: `Prepared demo template, not Claude: ${planned.unavailable}`, status: 'complete' });
        return { proposalId: null, demo: true };
      }
      const ops = planned;
      const preview = applyChangeOps(base.config, ops, { scope });
      const proposal = insertProposal(app.db, {
        projectId: ctx.projectId,
        baseVersionId: base.id,
        scope,
        request,
        summary: template.summary,
        explanation: template.explanation,
        ops,
        results: preview.results,
        origin: 'demo',
        model: null,
        jobId: ctx.jobId,
        status: preview.results.some((r) => r.status === 'applied') ? 'proposed' : 'failed',
      });
      updateMessage(app.db, reply.id, { text: `Prepared demo template, not Claude. ${template.explanation}`, status: 'complete', proposalId: proposal.id });
      return { proposalId: proposal.id, demo: true };
    }

    ctx.stage('context', scope.kind === 'scene' ? 'Reading the selected scene and its source slides' : 'Reading the whole game configuration');
    const brief = projectBrief(getProjectRow(app.db, ctx.projectId));
    const scoped = scope.kind === 'scene' ? base.config.scenes.filter((s) => s.id === scope.sceneId) : base.config.scenes;
    if (scope.kind === 'scene' && scoped.length === 0) throw new JobFailure('The selected scene is not in this version.', 'not_found', false);
    const slideIds = new Set(scoped.flatMap((s) => s.sourceSlideIds));
    const slides = listSlides(app.db, ctx.projectId).filter((s) => slideIds.has(s.id));
    const scopeLine =
      scope.kind === 'scene'
        ? `Scope: selected scene ${scope.sceneId} (scene ${base.config.scenes.findIndex((s) => s.id === scope.sceneId) + 1} of ${base.config.scenes.length}). Only this scene's fields may change.`
        : 'Scope: whole project. Scene fields, project fields and scene order may change.';
    const content = [
      scopeLine,
      `Game version: v${base.number}.`,
      configContext(base.config, scope),
      assetCatalog(app, ctx.projectId),
      slides.length ? `Source slides behind the scoped scene(s):\n${slides.map((s) => slideBlock(s, { includeNotes: false })).join('\n\n')}` : '',
      conversationSummary(ctx, userMessage.id),
      `<creator_request>\n${request}\n</creator_request>`,
    ]
      .filter(Boolean)
      .join('\n\n');

    ctx.stage('propose', 'Drafting a proposal');
    let streamed = '';
    let lastFlush = 0;
    const r = await app.gateway.chat(
      { system: REFINE_SYSTEM, content, tools: [PROPOSE_CHANGES_TOOL as unknown as Anthropic.Beta.BetaTool], maxTokens: 16000, effort: 'medium' },
      ctx.claude('refine', (delta) => {
        streamed += delta;
        ctx.streamText(delta);
        if (Date.now() - lastFlush > 400) {
          updateMessage(app.db, reply.id, { text: streamed });
          lastFlush = Date.now();
        }
      }),
    );
    ctx.recordCall(r);
    const call = r.toolCalls.find((t) => t.name === 'propose_changes');
    if (!call) {
      updateMessage(app.db, reply.id, { text: r.text.trim() || 'I could not turn that into a change. Could you describe what should look or behave differently?', status: 'complete' });
      return { proposalId: null };
    }
    ctx.stage('validate', 'Validating the proposed changes');
    const parsed = proposeChangesInputSchema.safeParse(call.input);
    if (!parsed.success) throw new JobFailure('Claude’s proposal did not match the expected structure. Nothing was changed — try again.', 'invalid_proposal', true);
    const { ops, rejected } = toOps(parsed.data.changes);
    const preview = applyChangeOps(base.config, ops, { scope });
    const applicable = preview.results.filter((x) => x.status === 'applied').length;
    for (const msg of rejected) ctx.event('warning', msg);
    for (const c of parsed.data.conflictsNoticed) ctx.event('warning', `Conflict noted by Claude: ${c}`);
    const proposal = insertProposal(app.db, {
      projectId: ctx.projectId,
      baseVersionId: base.id,
      scope,
      request,
      summary: parsed.data.summary.slice(0, 200) || 'Proposed change',
      explanation: [parsed.data.explanation.slice(0, 600), ...rejected, ...parsed.data.conflictsNoticed.map((c) => `Conflict: ${c}`)].filter(Boolean).join('\n'),
      ops,
      results: preview.results,
      origin: 'claude',
      model: r.model,
      jobId: ctx.jobId,
      status: applicable > 0 ? 'proposed' : 'failed',
    });
    updateMessage(app.db, reply.id, { text: r.text.trim() || parsed.data.summary, status: 'complete', proposalId: proposal.id });
    ctx.event('info', applicable > 0 ? `Proposal ready: ${applicable} change(s) to review.` : 'No change in the proposal can be applied (locks, scope or validation).');
    return { proposalId: proposal.id };
  } catch (err) {
    updateMessage(app.db, reply.id, { status: ctx.signal.aborted ? 'cancelled' : 'failed', text: getMessage(app.db, reply.id).text || (ctx.signal.aborted ? 'Stopped.' : 'This request failed — see the activity log. Nothing was changed.') });
    throw err;
  }
}

export async function handleAsk(ctx: JobContext<'ask'>) {
  const { app } = ctx;
  const { messageId, slideId, sceneId, question } = ctx.input();
  const userMessage = getMessage(app.db, messageId);
  const reply = insertMessage(app.db, {
    projectId: ctx.projectId,
    role: 'claude',
    text: '',
    scope: userMessage.scope,
    area: userMessage.area,
    origin: ctx.mode === 'demo' ? 'demo' : 'claude',
    status: 'streaming',
    jobId: ctx.jobId,
  });
  try {
    if (ctx.mode === 'demo') {
      updateMessage(app.db, reply.id, {
        text: 'Answering questions needs a configured Claude connection (Settings → Claude). The sample project’s analysis and blueprint are prepared fixtures.',
        status: 'complete',
      });
      return { demo: true };
    }
    const brief = projectBrief(getProjectRow(app.db, ctx.projectId));
    const analysis = currentAnalysis(app.db, ctx.projectId);
    const parts: string[] = [briefBlock(brief)];
    if (analysis) parts.push(analysisSummaryBlock(analysis.analysis));
    if (slideId) parts.push(`The creator is looking at this slide:\n${slideBlock(getSlide(app.db, slideId), { includeNotes: brief.aiInputs.includeSpeakerNotes })}`);
    if (sceneId) {
      const version = currentVersion(app.db, ctx.projectId);
      const scene = version?.config.scenes.find((s) => s.id === sceneId);
      if (scene) parts.push(`The creator is looking at this game scene:\n<scene_config>\n${JSON.stringify(scene)}\n</scene_config>`);
    }
    parts.push(`<creator_request>\n${question}\n</creator_request>`);
    ctx.stage('answer', 'Answering');
    let streamed = '';
    let lastFlush = 0;
    const r = await app.gateway.chat(
      { system: ASK_SYSTEM, content: parts.join('\n\n'), maxTokens: 8000, effort: 'low' },
      ctx.claude('ask', (delta) => {
        streamed += delta;
        ctx.streamText(delta);
        if (Date.now() - lastFlush > 400) {
          updateMessage(app.db, reply.id, { text: streamed });
          lastFlush = Date.now();
        }
      }),
    );
    ctx.recordCall(r);
    updateMessage(app.db, reply.id, { text: r.text.trim() || '(No answer was returned.)', status: 'complete' });
    return { messageId: reply.id };
  } catch (err) {
    updateMessage(app.db, reply.id, { status: ctx.signal.aborted ? 'cancelled' : 'failed', text: getMessage(app.db, reply.id).text || (ctx.signal.aborted ? 'Stopped.' : 'The question could not be answered — see the activity log.') });
    throw err;
  }
}
