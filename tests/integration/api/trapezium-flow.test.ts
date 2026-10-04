import './env.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GradePlanRecord } from '@shared/schemas/grade.ts';
import { profileForGrade } from '@shared/schemas/grade.ts';
import type { MotionPlanRecord } from '@shared/schemas/motion.ts';
import type { ProjectDetail } from '@shared/schemas/project.ts';
import type { GameVersion } from '@shared/schemas/records.ts';
import type { ScreenMapRecord } from '@shared/schemas/screens.ts';
import { validateBindings } from '@shared/motion/validate.ts';
import { resetSecretsForTests } from '../../../server/src/secrets.ts';
import { Studio } from './helpers.ts';

/**
 * The Grade 8 trapezium sample through the real API without a Claude key
 * (demo mode replays prepared answers for this bundled sample only; preset
 * rules elsewhere). Proves the staged Prepare → review → Approve & build path,
 * motion requests (including unsupported ones), and grade-version branches.
 */

let studio: Studio;
let project: ProjectDetail;

async function json<T>(p: Promise<{ statusCode: number; body: string; json(): unknown }>, status = 200): Promise<T> {
  const res = await p;
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
}

beforeAll(async () => {
  studio = await Studio.start();
  project = (await json<{ project: ProjectDetail }>(studio.post('/api/projects/sample', { which: 'trapezium' }), 201)).project;
});
afterAll(() => studio.close());

describe('Grade 8 trapezium sample (demo mode, no API key)', () => {
  it('imports the sample lesson, exported screens and artwork through the normal pipelines', async () => {
    for (const kind of ['lesson', 'screens', 'artwork'] as const) await json(studio.post(`/api/projects/${project.id}/sample-files`, { kind }), 201);
    await studio.runJobs();
    const slides = await studio.slides(project.id);
    expect(slides.map((s) => s.extract.title)).toEqual(['Trapezium Quest', 'What is a trapezium?', 'Spot the parallel sides', 'Trapezium or not?', 'Match the shapes', 'Teacher answer key', 'Expedition complete']);
    const design = await json<{ imports: Array<{ kind: string; frames: unknown[] }> }>(studio.get(`/api/projects/${project.id}/design`));
    expect(design.imports[0]).toMatchObject({ kind: 'exported' });
    expect(design.imports[0]!.frames).toHaveLength(5);
    const assets = await json<{ assets: Array<{ name: string; role: string; metadata: { sprite: { clips: Array<{ name: string }> } | null } }> }>(studio.get(`/api/projects/${project.id}/assets`));
    const swiftee = assets.assets.find((a) => a.name === 'Swiftee')!;
    expect(swiftee.metadata.sprite?.clips.map((c) => c.name)).toEqual(['idle', 'wave', 'celebrate']);
  });

  it('refuses to prepare before the grade is set, then prepares staged proposals', async () => {
    const refused = await studio.post(`/api/projects/${project.id}/prepare`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/grade/i);
    await json(studio.put(`/api/projects/${project.id}/grade`, { profile: profileForGrade(8), expectedRevision: 0 }));
    const { job, mode } = await json<{ job: { id: string }; mode: string }>(studio.post(`/api/projects/${project.id}/prepare`), 202);
    expect(mode).toBe('demo');
    await studio.runJobs();
    const done = (await studio.job(job.id)).job;
    expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
    const stages = (done.result as { stages: Array<{ key: string; status: string }> }).stages;
    expect(stages.map((s) => s.key)).toEqual(['gameplay', 'screens', 'assets', 'grade', 'motion']);
    expect(stages.every((s) => s.status === 'review' || s.status === 'done')).toBe(true);
    const map = await json<{ current: ScreenMapRecord }>(studio.get(`/api/projects/${project.id}/screen-map`));
    expect(map.current.origin).toBe('suggested');
    expect(map.current.mapping.screens.map((s) => s.screenId)).toEqual(['title', 'scn_trap_intro', 'scn_trap_identify', 'scn_trap_match', 'completion']);
    expect(map.current.mapping.screens.every((s) => !s.reviewed)).toBe(true);
    // Exact artwork from the library is suggested, not invented.
    const identify = map.current.mapping.screens.find((s) => s.screenId === 'scn_trap_identify')!;
    expect(identify.assets.character).toBeTruthy();
    expect(identify.assets.characterClip).toBe('idle');
    expect(identify.assets.panel).toBeTruthy();
    expect(identify.assets.button).toBeTruthy();
    expect(identify.background.kind).toBe('asset');
  });

  it('shows real readiness checks, then Approve & build applies only accepted plan rows', async () => {
    const r1 = await json<{ checks: Array<{ id: string; status: string }>; canBuild: boolean; gradePlanId: string; motionPlanId: string }>(studio.get(`/api/projects/${project.id}/readiness`));
    expect(r1.checks.map((c) => c.id)).toEqual(['source', 'grade', 'mechanics', 'screens', 'assets', 'motion', 'export']);
    expect(r1.checks.find((c) => c.id === 'mechanics')!.status).toBe('pass');
    expect(r1.checks.find((c) => c.id === 'grade')!.status).toBe('todo');
    expect(r1.canBuild).toBe(true);
    const grade = (await json<{ plans: GradePlanRecord[] }>(studio.get(`/api/projects/${project.id}/grade-plans`))).plans[0]!;
    expect(grade.origin).toBe('demo');
    expect(grade.baseVersionId).toBeNull();
    // Accept the concrete presentation changes; reject the density change.
    const decisions = Object.fromEntries(grade.plan.items.map((i) => [i.id, i.change && i.change.field !== 'layout.density' ? 'accepted' : 'rejected']));
    await json(studio.patch(`/api/grade-plans/${grade.id}/decisions`, { decisions }));
    const motion = (await json<{ plans: MotionPlanRecord[] }>(studio.get(`/api/projects/${project.id}/motion-plans`))).plans[0]!;
    expect(motion.baseVersionId).toBeNull();
    expect(motion.plan.add.length).toBeGreaterThan(3);
    const accept = Object.fromEntries(Object.keys(motion.decisions).map((k) => [k, 'accepted']));
    await json(studio.patch(`/api/motion-plans/${motion.id}/decisions`, { decisions: accept }));
    const { job } = await json<{ job: { id: string } }>(studio.post(`/api/projects/${project.id}/approve-build`, {}), 202);
    await studio.runJobs();
    const built = (await studio.job(job.id)).job;
    expect(built.status, JSON.stringify(built.error)).toBe('succeeded');
    const bundle = await json<{ config: GameVersion['config'] }>(studio.get(`/api/projects/${project.id}/preview-bundle`));
    const cfg = bundle.config;
    expect(cfg.meta.gradeLabel).toBe('Grade 8');
    expect(cfg.meta.screenMapNumber).toBe(1);
    const identify = cfg.scenes.find((s) => s.id === 'scn_trap_identify')!;
    expect(identify.instruction).toBe('Sort each shape: does it have at least one pair of parallel sides?');
    expect(identify.feedback.hints).toHaveLength(3);
    expect(identify.layout.density).toBe('comfortable');
    expect(identify.assets.character).toBeTruthy();
    expect(cfg.assets[identify.assets.character!]!.sprite?.clips.map((c) => c.name)).toContain('wave');
    // Source definitions stay as the lesson states them.
    const intro = cfg.scenes.find((s) => s.id === 'scn_trap_intro')!;
    expect(intro.interaction.type === 'info' && intro.interaction.points[0]).toBe('A trapezium is a quadrilateral with at least one pair of parallel sides.');
    expect(cfg.motion.bindings.length).toBe(motion.plan.add.length);
    expect(validateBindings(cfg).filter((i) => i.severity === 'error')).toEqual([]);
    const plans = await json<{ plans: GradePlanRecord[] }>(studio.get(`/api/projects/${project.id}/grade-plans`));
    expect(plans.plans[0]!.status).toBe('applied');
  });

  it('turns a creator motion request into validated rows, and reports unsupported requests honestly', async () => {
    const before = await json<{ config: GameVersion['config']; version: { id: string } }>(studio.get(`/api/projects/${project.id}/preview-bundle`));
    const start = await json<{ job: { id: string } }>(
      studio.post(`/api/projects/${project.id}/motion-plans`, { scope: { kind: 'screen', screenId: 'scn_trap_identify' }, request: 'On this screen, play Swiftee’s wave when the screen opens, then reveal the instruction panel. Keep the trapezium stationary.' }),
      202,
    );
    await studio.runJobs();
    expect((await studio.job(start.job.id)).job.status).toBe('succeeded');
    const plan = (await json<{ plans: MotionPlanRecord[] }>(studio.get(`/api/projects/${project.id}/motion-plans`))).plans[0]!;
    expect(plan.origin).toBe('demo');
    expect(plan.plan.add.map((b) => [b.presetId, b.target, b.trigger.event])).toEqual([
      ['character-clip', 'character', 'scene-entered'],
      ['fade-in', 'instruction', 'scene-entered'],
    ]);
    expect(plan.plan.add[1]!.after).toBe(plan.plan.add[0]!.id);
    expect(plan.plan.add[0]!.label).toBe('When Screen 3 · Spot the parallel sides opens → play Swiftee\'s “wave” clip once.');
    expect(plan.plan.notes.join(' ')).toMatch(/stationary/);
    expect(plan.gradeProfileRevision).toBe(1);
    await json(studio.patch(`/api/motion-plans/${plan.id}/decisions`, { decisions: Object.fromEntries(Object.keys(plan.decisions).map((k) => [k, 'accepted'])) }));
    const applied = await json<{ version: GameVersion; proposal: { id: string } }>(studio.post(`/api/motion-plans/${plan.id}/apply`));
    expect(applied.version.config.motion.bindings.length).toBe(before.config.motion.bindings.length + 2);
    // Only the selected screen changed.
    const changed = applied.version.config.motion.bindings.filter((b) => !before.config.motion.bindings.some((x) => x.id === b.id));
    expect(changed.every((b) => b.screenId === 'scn_trap_identify')).toBe(true);
    expect(applied.version.config.scenes).toEqual(before.config.scenes);

    const odd = await json<{ job: { id: string } }>(studio.post(`/api/projects/${project.id}/motion-plans`, { scope: { kind: 'project', screenId: null }, request: 'Make Swiftee talk, shake the screen and add full-screen confetti' }), 202);
    await studio.runJobs();
    expect((await studio.job(odd.job.id)).job.status).toBe('succeeded');
    const unsupported = (await json<{ plans: MotionPlanRecord[] }>(studio.get(`/api/projects/${project.id}/motion-plans`))).plans[0]!;
    expect(unsupported.plan.add).toEqual([]);
    expect(unsupported.plan.unsupported.map((u) => u.request)).toEqual(['Make the character talk', 'Shake or flash', 'Full-screen confetti']);

    // Undo the applied plan through its proposal (history kept).
    const undo = await json<{ version: GameVersion }>(studio.post(`/api/proposals/${applied.proposal.id}/undo`));
    expect(undo.version.config.motion.bindings).toEqual(before.config.motion.bindings);
  });

  it('creates another grade version that changes independently, leaving the Grade 8 version untouched', async () => {
    const g8 = await json<{ config: GameVersion['config']; version: { id: string; number: number } }>(studio.get(`/api/projects/${project.id}/preview-bundle`));
    const created = await json<{ branch: { id: string; gradeLabel: string; active: boolean }; branches: Array<{ id: string }> }>(studio.post(`/api/projects/${project.id}/branches`, { name: 'Grade 6 version', profile: profileForGrade(6) }), 201);
    expect(created.branch).toMatchObject({ gradeLabel: 'Grade 6', active: true });
    const g6 = await json<{ config: GameVersion['config'] }>(studio.get(`/api/projects/${project.id}/preview-bundle`));
    expect(g6.config.meta.branchId).toBe(created.branch.id);
    expect(g6.config.motion).toEqual(g8.config.motion);
    // An independent change in the Grade 6 version.
    const edit = await json<{ version: GameVersion }>(
      studio.post(`/api/projects/${project.id}/edits`, { baseVersionId: (await studio.project(project.id)).currentVersionId, ops: [{ op: 'set-motion-setting', field: 'pacing', value: 'calm' }, { op: 'set-motion-setting', field: 'profile', value: 'playful' }], scope: { kind: 'project', sceneId: null }, summary: 'Grade 6 motion' }),
    );
    expect(edit.version.config.motion.profile).toBe('playful');
    // Back to Grade 8: unchanged.
    const main = created.branches.find((b) => b.id !== created.branch.id)!;
    await json(studio.post(`/api/projects/${project.id}/branches/${main.id}/activate`));
    const again = await json<{ config: GameVersion['config']; version: { id: string } }>(studio.get(`/api/projects/${project.id}/preview-bundle`));
    expect(again.version.id).toBe(g8.version.id);
    expect(again.config.motion.profile).toBe(g8.config.motion.profile);
    const versions = await json<{ versions: Array<{ branchId: string }> }>(studio.get(`/api/projects/${project.id}/versions`));
    expect(versions.versions.every((v) => v.branchId === main.id)).toBe(true);
  });

  it('exports the Grade 8 version: the playable game matches the preview, the handoff adds grade, map and motion files, and nothing private leaks', async () => {
    const FIGMA_TOKEN = 'figd_integration-test-token-0000';
    process.env.FIGMA_ACCESS_TOKEN = FIGMA_TOKEN;
    resetSecretsForTests();
    try {
      const preview = await json<{ config: GameVersion['config'] }>(studio.get(`/api/projects/${project.id}/preview-bundle`));
      const library = await json<{ assets: Array<{ id: string; role: string; name: string }> }>(studio.get(`/api/projects/${project.id}/assets`));
      const references = library.assets.filter((a) => a.role === 'reference').map((a) => a.id);
      expect(references.length).toBeGreaterThan(0);

      // Playable: static, offline, only assets in use; same game and motion as the preview.
      const playable = await studio.exportZip(project.id, { kind: 'playable' });
      const folder = 'trapezium-quest';
      const js = playable.entries.get(`${folder}/game.config.js`)!.toString('utf8');
      const exported = JSON.parse(js.slice(js.indexOf('=') + 1).trim().replace(/;$/, '')) as GameVersion['config'];
      expect(exported.scenes).toEqual(preview.config.scenes);
      expect(exported.motion).toEqual(preview.config.motion);
      expect(exported.screens).toEqual(preview.config.screens);
      for (const id of references) expect(exported.assets[id], `reference asset ${id} exported`).toBeUndefined();
      for (const a of Object.values(exported.assets)) expect(playable.entries.has(`${folder}/${a.file}`), a.file).toBe(true);
      const checks = Object.fromEntries(playable.record.preflight.checks.map((c) => [c.id, c.status]));
      expect(checks).toMatchObject({ schema: 'pass', motion: 'pass', offline: 'pass', secrets: 'pass', grade: 'info' });

      // Handoff: grade profile, design map, animation guide and manifest — no design dumps, prompts or tokens.
      const handoff = await studio.exportZip(project.id, { kind: 'handoff' });
      const hf = 'trapezium-quest-claude-handoff';
      const text = (name: string) => handoff.entries.get(`${hf}/${name}`)?.toString('utf8') ?? '';
      expect(text('GRADE_PROFILE.md')).toMatch(/Grade 8/);
      expect(text('GRADE_PROFILE.md')).toMatch(/not scientifically validated/);
      expect(text('ANIMATION_GUIDE.md')).toMatch(/When Screen 2 · What is a trapezium\? opens/);
      const manifest = JSON.parse(text('animation-manifest.json')) as { animations: Array<{ id: string; rule: string }>; validation: unknown[] };
      expect(manifest.animations.map((a) => a.id)).toEqual(preview.config.motion.bindings.map((b) => b.id));
      expect(manifest.animations.every((a) => !/\banim-[a-z0-9-]+\)/.test(a.rule))).toBe(true);
      const map = JSON.parse(text('design-map.json')) as { screens: Array<{ screenId: string; frames: Array<Record<string, unknown>> }> };
      expect(map.screens.map((x) => x.screenId)).toEqual(['title', 'scn_trap_intro', 'scn_trap_identify', 'scn_trap_match', 'completion']);
      for (const scr of map.screens) for (const f of scr.frames) expect(Object.keys(f)).not.toContain('elements');
      expect(text('CLAUDE.md')).toMatch(/ANIMATION_GUIDE\.md/);
      for (const [name, data] of [...playable.entries, ...handoff.entries]) {
        const body = data.toString('utf8');
        expect(body.includes(FIGMA_TOKEN), `${name} contains the Figma token`).toBe(false);
        expect(body.includes('Keep the trapezium stationary'), `${name} contains a motion request`).toBe(false);
        expect(body.includes('Make Swiftee talk'), `${name} contains a motion request`).toBe(false);
      }
    } finally {
      delete process.env.FIGMA_ACCESS_TOKEN;
      resetSecretsForTests();
    }
  });
});
