import './env.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOT_WRITTEN, type BlueprintRevision } from '@shared/schemas/blueprint.ts';
import { gameConfigSchema } from '@shared/schemas/game.ts';
import type { GameVersion } from '@shared/schemas/records.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { idempotencyKey, Studio } from './helpers.ts';

describe('blueprint → approval → build', () => {
  let s: Studio;
  let projectId: string;
  let slides: SourceSlide[];
  let draft: BlueprintRevision;
  let approved: BlueprintRevision;
  let v1: GameVersion;

  beforeAll(async () => {
    s = await Studio.start();
    projectId = (await s.createProject('Blueprint project')).id;
    slides = (await s.importDeck(projectId)).slides;
  });

  afterAll(async () => {
    await s.close();
  });

  const getRevision = async (id: string) => (await s.get(`/api/blueprints/${id}`)).json().revision as BlueprintRevision;
  const queueBuild = (blueprintRevisionId: string) => s.post(`/api/projects/${projectId}/jobs`, { type: 'build', input: { blueprintRevisionId } }, { 'idempotency-key': idempotencyKey() });

  it('refuses a hand-started blueprint while no slide is included', async () => {
    const empty = await s.createProject('No slides yet');
    const res = await s.post(`/api/projects/${empty.id}/blueprints/manual`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Include at least one slide before starting a blueprint.');
  });

  it('creates a creator-authored draft with one concept card per included slide (no AI)', async () => {
    const res = await s.post(`/api/projects/${projectId}/blueprints/manual`);
    expect(res.statusCode, res.body).toBe(201);
    draft = res.json().revision as BlueprintRevision;
    expect(draft).toMatchObject({ number: 1, status: 'draft', origin: 'creator', model: null, parentId: null, stale: false, approvedAt: null, revision: 0 });

    const included = slides.filter((x) => x.included);
    expect(included).toHaveLength(8);
    const scenes = draft.blueprint.scenes;
    expect(scenes.map((sc) => sc.sourceSlideIds)).toEqual(included.map((x) => [x.id]));
    expect(scenes.map((sc) => sc.title)).toEqual(included.map((x) => x.extract.title));
    expect(scenes.every((sc) => sc.interaction.type === 'info' && sc.origin === 'creator')).toBe(true);
    expect(scenes.map((sc) => sc.next)).toEqual([...scenes.slice(1).map((sc) => sc.id), null]);
    expect(draft.blueprint.premise.startsWith(NOT_WRITTEN)).toBe(true);

    const structural = res.json().issues.structural as Array<{ severity: string; message: string }>;
    expect(structural.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual(['Write the story premise — learners see it on the title screen.']);
    expect(structural.filter((i) => i.severity === 'warning')).toHaveLength(3);

    const p = await s.project(projectId);
    expect(p).toMatchObject({ latestBlueprintId: draft.id, approvedBlueprintId: null, state: 'blueprint_ready' });
  });

  it('blocks approval while the premise is the "Not written yet" placeholder', async () => {
    const res = await s.post(`/api/blueprints/${draft.id}/approve`, { revision: draft.revision });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Blueprint r1 has problems that block approval: Write the story premise — learners see it on the title screen.');
    expect(res.json().error.hint).toBeTruthy();
    expect((await getRevision(draft.id)).status).toBe('draft');
  });

  it('saves draft edits with validation and optimistic concurrency', async () => {
    const blueprint = structuredClone(draft.blueprint);
    blueprint.premise = 'You are an air traffic controller learning to read the airfield grid.';

    const invalid = await s.put(`/api/blueprints/${draft.id}`, { blueprint: { ...blueprint, title: '' }, revision: draft.revision });
    expect(invalid.statusCode).toBe(400);

    const ok = await s.put(`/api/blueprints/${draft.id}`, { blueprint, revision: draft.revision });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().revision).toMatchObject({ revision: 1, status: 'draft', blueprint: { premise: blueprint.premise } });
    expect((ok.json().issues.structural as Array<{ severity: string }>).filter((i) => i.severity === 'error')).toEqual([]);

    const stale = await s.put(`/api/blueprints/${draft.id}`, { blueprint: { ...blueprint, premise: 'Overwritten from a stale tab.' }, revision: draft.revision });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toBe('This draft changed since you loaded it.');
    draft = ok.json().revision as BlueprintRevision;
    expect((await getRevision(draft.id)).blueprint.premise).toBe(blueprint.premise);
  });

  it('approves the written draft; approved revisions are immutable through the API and in the database', async () => {
    const staleApproval = await s.post(`/api/blueprints/${draft.id}/approve`, { revision: 0 });
    expect(staleApproval.statusCode).toBe(409);
    expect(staleApproval.json().error.message).toBe('This draft changed since you reviewed it.');

    const res = await s.post(`/api/blueprints/${draft.id}/approve`, { revision: draft.revision });
    expect(res.statusCode, res.body).toBe(200);
    approved = res.json().revision as BlueprintRevision;
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).toBeTruthy();
    expect(await s.project(projectId)).toMatchObject({ approvedBlueprintId: approved.id, state: 'approved', statusLabel: 'Blueprint approved' });

    const edit = await s.put(`/api/blueprints/${approved.id}`, { blueprint: { ...approved.blueprint, premise: 'Changed after approval.' }, revision: approved.revision });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.message).toBe('Blueprint r1 is approved and cannot be edited.');
    const twice = await s.post(`/api/blueprints/${approved.id}/approve`, { revision: approved.revision });
    expect(twice.statusCode).toBe(409);

    // The trigger guards the stored revision on every connection, whatever code path tries.
    for (const db of [s.app.db, s.worker.db]) {
      expect(() => db.run('UPDATE blueprint_revisions SET blueprint_json = ? WHERE id = ?', ['{}', approved.id])).toThrow(/approved blueprint revisions are immutable/);
      expect(() => db.run('UPDATE blueprint_revisions SET source_revision = ? WHERE id = ?', ['tampered', approved.id])).toThrow(/immutable/);
      expect(() => db.run('UPDATE blueprint_revisions SET number = 99 WHERE id = ?', [approved.id])).toThrow(/immutable/);
      expect(() => db.run("UPDATE blueprint_revisions SET status = 'draft' WHERE id = ?", [approved.id])).toThrow(/cannot return to draft/);
    }
    const after = await getRevision(approved.id);
    expect(after.blueprint).toEqual(approved.blueprint);
    expect(after.status).toBe('approved');
  });

  it('refuses to build anything but an approved revision of this project', async () => {
    const newDraft = await s.post(`/api/blueprints/${approved.id}/draft`);
    expect(newDraft.statusCode).toBe(201);
    const r2 = newDraft.json().revision as BlueprintRevision;
    expect(r2).toMatchObject({ number: 2, status: 'draft', parentId: approved.id });

    const fromDraft = await queueBuild(r2.id);
    expect(fromDraft.statusCode).toBe(409);
    expect(fromDraft.json().error.message).toBe('Blueprint r2 is not approved.');
    expect((await queueBuild('bpr_doesnotexist')).statusCode).toBe(404);
    const other = await s.createProject('Other project');
    expect((await s.post(`/api/projects/${other.id}/jobs`, { type: 'build', input: { blueprintRevisionId: approved.id } })).statusCode).toBe(404);
    expect((await s.project(projectId)).activeJobs).toEqual([]);
  });

  it('builds game version v1 from the approved revision with a valid GameConfig (no AI)', async () => {
    const res = await queueBuild(approved.id);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().job).toMatchObject({ type: 'build', mode: 'local', status: 'queued', model: null });
    const jobId = res.json().job.id as string;
    expect((await s.project(projectId)).state).toBe('building');
    expect(await s.runJobs()).toBe(1);

    const { job, events } = await s.job(jobId);
    expect(job.status).toBe('succeeded');
    expect(job.usage).toBeNull();
    expect(job.result).toMatchObject({ number: 1 });
    const messages = events.map((e) => e.message);
    for (const m of ['Validating approved blueprint r1', 'Compiling scenes with the trusted game templates', 'Checking that every scene can be completed', 'Saving the new playable version', 'Version 1 is playable (8 scenes).']) {
      expect(messages).toContain(m);
    }

    const versionId = (job.result as { versionId: string }).versionId;
    v1 = (await s.get(`/api/versions/${versionId}`)).json().version as GameVersion;
    expect(v1).toMatchObject({ number: 1, origin: 'build', demo: false, blueprintRevisionId: approved.id, blueprintRevisionNumber: 1, parentVersionId: null });
    const parsed = gameConfigSchema.safeParse(v1.config);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    expect(v1.config).toMatchObject({ id: v1.id, kind: 'nexus-game', schemaVersion: 1, meta: { projectId, versionNumber: 1, blueprintRevisionId: approved.id, blueprintRevisionNumber: 1, origin: 'build', demo: false } });
    expect(v1.config.scenes.map((sc) => sc.sourceSlideIds)).toEqual(approved.blueprint.scenes.map((sc) => sc.sourceSlideIds));
    expect(v1.config.screens.title.subheading).toBe(approved.blueprint.premise.slice(0, 160));

    expect(await s.project(projectId)).toMatchObject({ currentVersionId: v1.id, currentVersionNumber: 1, state: 'playable', statusLabel: 'Playable' });
    const bundle = (await s.get(`/api/projects/${projectId}/preview-bundle`)).json();
    expect(bundle.version).toMatchObject({ id: v1.id, number: 1, demo: false });
    expect(bundle.config).toEqual(v1.config);
  });

  it('game versions are immutable in the database', async () => {
    for (const db of [s.app.db, s.worker.db]) {
      expect(() => db.run('UPDATE game_versions SET config_json = ? WHERE id = ?', ['{}', v1.id])).toThrow(/game versions are immutable/);
      expect(() => db.run('UPDATE game_versions SET number = 7 WHERE id = ?', [v1.id])).toThrow(/game versions are immutable/);
      expect(() => db.run('UPDATE game_versions SET parent_version_id = ? WHERE id = ?', ['ver_other', v1.id])).toThrow(/game versions are immutable/);
      expect(() => db.run('UPDATE game_versions SET blueprint_revision_id = ? WHERE id = ?', ['bpr_other', v1.id])).toThrow(/game versions are immutable/);
    }
    expect((await s.get(`/api/versions/${v1.id}`)).json().version.config).toEqual(v1.config);
  });

  it('approving a new revision supersedes the old one; a failed build leaves the last playable version current', async () => {
    const r2 = (await s.get(`/api/projects/${projectId}/blueprints`)).json().revisions.find((r: BlueprintRevision) => r.number === 2) as BlueprintRevision;
    const ok = await s.post(`/api/blueprints/${r2.id}/approve`, { revision: r2.revision });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await getRevision(approved.id)).status).toBe('superseded');
    expect(() => s.app.db.run("UPDATE blueprint_revisions SET status = 'draft' WHERE id = ?", [approved.id])).toThrow(/cannot return to draft/);
    const v2 = await s.build(projectId, r2.id);
    expect(v2).toMatchObject({ number: 2, parentVersionId: v1.id, blueprintRevisionNumber: 2 });

    // r3 asks for a mechanic the trusted templates cannot build.
    const r3 = (await s.post(`/api/blueprints/${r2.id}/draft`)).json().revision as BlueprintRevision;
    const blueprint = structuredClone(r3.blueprint);
    blueprint.scenes[0]!.interaction = { type: 'custom', description: 'Learners flip cards to find matching coordinate pairs against a timer.' };
    const saved = await s.put(`/api/blueprints/${r3.id}`, { blueprint, revision: r3.revision });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await s.post(`/api/blueprints/${r3.id}/approve`, { revision: saved.json().revision.revision })).statusCode).toBe(200);

    const res = await queueBuild(r3.id);
    expect(res.statusCode).toBe(202);
    await s.runJobs();
    const { job } = await s.job(res.json().job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'build_invalid', retryable: false });
    expect(job.error!.message).toMatch(/blueprint but not an in-app build yet/);
    expect(job.error!.message).toMatch(/The previous playable version is unchanged\.$/);
    const p = await s.project(projectId);
    expect(p).toMatchObject({ currentVersionId: v2.id, currentVersionNumber: 2, statusLabel: 'Needs attention', statusDetail: 'Build game failed — v2 is still playable.' });
  });
});
