/**
 * “Your work is saved — retry”: failed AI jobs are retried through the API.
 * Completed stages are reused (not re-run and not re-billed); only the failed
 * stage calls Claude again. Exercised on analysis and on the multi-call
 * blueprint flow (outline → scene batch).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BlueprintRevision } from '@shared/schemas/blueprint.ts';
import type { AiOutline, AiSceneDetail } from '../../../server/src/claude/schemas.ts';
import { blockedRequests, promptText, slideIdsInPrompt, startMock, Studio, TEST_MODEL, validAnalysis } from './harness.ts';
import { reply, type MockAnthropic, type RecordedRequest } from './mock-anthropic.ts';

let mock: MockAnthropic;
let s: Studio;

beforeAll(async () => {
  mock = await startMock();
  s = await Studio.start(mock, { maxRetries: 2 });
  expect((await s.testConnection()).state).toBe('configured');
});

beforeEach(() => mock.reset());

afterEach(() => {
  expect(mock.unscripted.map((r) => `${r.method} ${r.url}`)).toEqual([]);
});

afterAll(async () => {
  await s?.close();
  await mock?.close();
  expect(blockedRequests).toEqual([]);
});

const answerFromPrompt = (req: RecordedRequest) => reply.json(validAnalysis(slideIdsInPrompt(req)));

function outlineFor(ids: string[]): AiOutline {
  const [, pairs = ids[0]!, quadrants = pairs] = ids;
  return {
    title: 'Coordinate Quest',
    premise: 'Guide a plane across the airfield grid using ordered pairs.',
    progression: 'A concept card first, then plotting a point with the target shown.',
    assessment: 'Learners must land exactly on the named point.',
    mechanicFit: 'Moving to a point practises reading (x, y) in the right order.',
    learningOutcomes: [{ text: 'Plot a point from an ordered pair', sourceSlideIds: [pairs], addedPractice: false }],
    accessibility: ['Keyboard controls for moving the plane'],
    assumptions: [],
    unresolvedDecisions: [],
    assetNeeds: [],
    scenes: [
      { key: 'scene-1', title: 'Ordered pairs', pattern: 'discover', sceneType: 'info', sourceSlideIds: [pairs], addedPractice: false, objective: 'Recall that x comes first', learnerAction: 'Read the card', expectedResult: 'The learner continues', difficulty: 'gentle', backgroundNeedKey: null, characterNeedKey: null },
      { key: 'scene-2', title: 'Fly to (3, 2)', pattern: 'manipulate', sceneType: 'coordinate-navigation', sourceSlideIds: [pairs, quadrants], addedPractice: false, objective: 'Plot (3, 2)', learnerAction: 'Move the plane', expectedResult: 'The plane is at (3, 2)', difficulty: 'standard', backgroundNeedKey: null, characterNeedKey: null },
    ],
  };
}

function sceneDetails(): { scenes: AiSceneDetail[] } {
  return {
    scenes: [
      {
        key: 'scene-1',
        visibleContent: 'A card explaining how to read (x, y).',
        instruction: 'Read the card, then continue.',
        successFeedback: 'Ready for take-off!',
        errorFeedback: 'Read the card once more.',
        hints: ['x comes first.'],
        completion: 'Continue is pressed.',
        interaction: { type: 'info', points: ['A point is written (x, y).', 'Move along x first, then y.'], illustration: 'grid', continueLabel: 'Continue' },
      },
      {
        key: 'scene-2',
        visibleContent: 'A grid with a plane at the origin.',
        instruction: 'Fly the plane to (3, 2).',
        successFeedback: 'Cleared to land!',
        errorFeedback: 'Check the order: move along x first, then y.',
        hints: ['Start with x = 3.', 'Then go up 2.'],
        completion: 'The plane is at (3, 2).',
        interaction: {
          type: 'coordinate-navigation',
          grid: { xMin: -5, xMax: 5, yMin: -5, yMax: 5, step: 1 },
          start: { x: 0, y: 0 },
          rule: { kind: 'point-equals', target: { x: 3, y: 2 } },
          showTargetMarker: true,
          showCoordinateReadout: true,
          moverLabel: 'Plane',
          landmarks: [],
          display: { gridEmphasis: 'standard', pointSize: 'standard', labelSize: 'standard' },
        },
      },
    ],
  };
}

describe('retrying failed AI jobs', () => {
  it('analysis: a truncated answer fails honestly; retrying through the API runs the stage again and stores the result', async () => {
    const { projectId } = await s.projectWithDeck();
    mock.enqueueMessages(reply.text('{"topic": "Coordin', { stopReason: 'max_tokens' }));
    const first = await s.analyze(projectId);
    expect(first.job).toMatchObject({ status: 'failed', attempt: 1, error: { code: 'claude_truncated', retryable: true } });
    expect(s.analysisCount(projectId)).toBe(0);

    mock.enqueueMessages(answerFromPrompt);
    const retried = await s.post(`/api/jobs/${first.job.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.job).toMatchObject({ status: 'queued', error: null });
    expect(await s.runNext()).toBe(true);
    const { job } = await s.getJob(first.job.id);
    expect(job).toMatchObject({ status: 'succeeded', attempt: 2, error: null });
    expect(s.analysisCount(projectId)).toBe(1);
    expect(mock.messageRequests()).toHaveLength(2);
    // Both calls were billed and both are in the usage log — the failed one is not hidden.
    expect(s.usageRows(job.id).map((r) => r.stop_reason)).toEqual(['max_tokens', 'end_turn']);
  });

  it('blueprint: when the scene batch fails (529 after bounded retries) the saved outline is reused on retry — not re-run, not re-billed', async () => {
    const { projectId, includedIds } = await s.projectWithDeck();
    mock.enqueueMessages(answerFromPrompt);
    expect((await s.analyze(projectId)).job.status).toBe('succeeded');
    mock.reset();

    let outlinePromptIds: string[] = [];
    mock.enqueueMessages(
      (req) => {
        outlinePromptIds = slideIdsInPrompt(req);
        return reply.json(outlineFor(outlinePromptIds));
      },
      reply.overloaded(),
      reply.overloaded(),
      reply.overloaded(),
    );
    const enqueued = await s.startJob(projectId, 'blueprint', { analysisId: null });
    expect(enqueued.status).toBe(202);
    expect(enqueued.body.job).toMatchObject({ mode: 'live', model: TEST_MODEL });
    const jobId = enqueued.body.job.id;
    await s.runNext();

    const failed = await s.getJob(jobId);
    expect(failed.job).toMatchObject({ status: 'failed', error: { code: 'claude_overloaded', retryable: true, stage: 'scenes:0' } });
    expect(outlinePromptIds).toEqual(includedIds);
    const firstRun = mock.messageRequests();
    expect(firstRun).toHaveLength(1 + 3); // outline + the scene batch tried 1 + CLAUDE_MAX_RETRIES times
    expect((firstRun[0]!.body as { output_config: unknown }).output_config).toMatchObject({ effort: 'high', format: { type: 'json_schema' } });
    expect((await s.get<{ revisions: BlueprintRevision[] }>(`/api/projects/${projectId}/blueprints`)).body.revisions).toEqual([]);
    expect(s.stageRows(jobId).map((r) => r.stage_key)).toEqual(['outline']);

    mock.reset();
    mock.enqueueMessages(reply.json(sceneDetails()));
    expect((await s.post(`/api/jobs/${jobId}/retry`)).status).toBe(200);
    await s.runNext();

    const done = await s.getJob(jobId);
    expect(done.job.status).toBe('succeeded');
    expect(done.events.some((e) => e.message === 'Reusing completed stage: Drafting the blueprint outline')).toBe(true);
    const secondRun = mock.messageRequests();
    expect(secondRun).toHaveLength(1); // only the failed scene batch was asked again
    expect(promptText(secondRun[0]!)).toContain('Write the full details for these scenes');
    expect(promptText(secondRun[0]!)).toContain('"key":"scene-2"');

    const revisions = (await s.get<{ revisions: BlueprintRevision[] }>(`/api/projects/${projectId}/blueprints`)).body.revisions;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ origin: 'claude', model: TEST_MODEL, status: 'draft', number: 1 });
    const bp = revisions[0]!.blueprint;
    expect(bp.title).toBe('Coordinate Quest');
    expect(bp.scenes.map((sc) => sc.interaction.type)).toEqual(['info', 'coordinate-navigation']);
    for (const sc of bp.scenes) for (const id of sc.sourceSlideIds) expect(includedIds).toContain(id);
    expect(s.usageRows(jobId).map((r) => r.stage)).toEqual(['blueprint-outline', 'blueprint-scenes']);
  });
});
