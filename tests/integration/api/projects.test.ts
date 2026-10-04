import './env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlueprintRevision } from '@shared/schemas/blueprint.ts';
import type { ProjectDetail, ProjectSummary } from '@shared/schemas/project.ts';
import type { GameVersion } from '@shared/schemas/records.ts';
import type { SourceSlide } from '@shared/schemas/source.ts';
import { listFilesRecursive, sha256, Studio } from './helpers.ts';

interface AssetRow {
  id: string;
  stored_dir: string;
  display_file: string;
  original_file: string;
  sha256: string;
}

describe('projects', () => {
  let s: Studio;

  beforeAll(async () => {
    s = await Studio.start();
  });

  afterAll(async () => {
    await s.close();
  });

  const list = async (search?: string): Promise<ProjectSummary[]> => {
    const res = await s.get(`/api/projects${search === undefined ? '' : `?search=${encodeURIComponent(search)}`}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().projects as ProjectSummary[];
  };

  describe('create, list and search', () => {
    it('creates projects with the given name or the default name', async () => {
      const named = await s.createProject('Fractions Lab');
      expect(named).toMatchObject({ name: 'Fractions Lab', isSample: false, state: 'draft', statusLabel: 'Draft', revision: 0, slideCount: 0, currentVersionNumber: null, briefRevision: 0, documents: [] });
      expect(named.id).toMatch(/^prj_[A-Za-z0-9]+$/);
      expect((await s.createProject()).name).toBe('Untitled game');
      expect((await s.createProject('   ')).name).toBe('Untitled game');

      const tooLong = await s.post('/api/projects', { name: 'x'.repeat(121) });
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json().error.code).toBe('bad_request');

      const ids = (await list()).map((p) => p.id);
      expect(ids).toContain(named.id);
      expect((await s.get('/api/projects/prj_doesnotexist')).statusCode).toBe(404);
    });

    it('lists the most recently updated first and searches name, subject and grade case-insensitively', async () => {
      const volcano = await s.createProject('Volcanoes of Iceland');
      await s.saveBrief(volcano.id, { subject: 'Geography', gradeOrAge: 'Grade 7' });
      await new Promise((r) => setTimeout(r, 5)); // updated_at has millisecond resolution
      const other = await s.createProject('Tide pools');

      const all = await list();
      expect(all[0]!.id).toBe(other.id);
      expect(all.findIndex((p) => p.id === volcano.id)).toBeGreaterThan(0);

      for (const q of ['VOLCANO', 'iceland', 'geogr', 'grade 7']) {
        expect((await list(q)).map((p) => p.id), q).toEqual([volcano.id]);
      }
      expect(await list('no-project-matches-this')).toEqual([]);
      expect((await s.get(`/api/projects?search=${'q'.repeat(201)}`)).statusCode).toBe(400);
    });
  });

  describe('rename and brief', () => {
    it('renames with optimistic concurrency: a stale revision is refused with 409', async () => {
      const p = await s.createProject('Rename me');
      const ok = await s.patch(`/api/projects/${p.id}`, { name: '  Renamed  ', revision: p.revision });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().project).toMatchObject({ name: 'Renamed', revision: p.revision + 1 });

      const stale = await s.patch(`/api/projects/${p.id}`, { name: 'Lost update', revision: p.revision });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toMatchObject({ code: 'conflict', message: 'The project changed since you loaded it.' });
      expect((await s.project(p.id)).name).toBe('Renamed');

      const empty = await s.patch(`/api/projects/${p.id}`, { name: '   ', revision: p.revision + 1 });
      expect(empty.statusCode).toBe(400);
      expect((await s.project(p.id)).name).toBe('Renamed');
    });

    it('the project name follows the brief title until the creator renames the project', async () => {
      const p = await s.createProject();
      expect(p.name).toBe('Untitled game');

      await s.saveBrief(p.id, { title: 'Volcano Quest' });
      let cur = await s.project(p.id);
      expect(cur.name).toBe('Volcano Quest');
      expect(cur.briefRevision).toBe(1);

      await s.saveBrief(p.id, { title: 'Volcano Quest II' });
      cur = await s.project(p.id);
      expect(cur.name).toBe('Volcano Quest II');

      // The automatic rename bumps the project revision, so a client holding the old one must reload.
      const staleRename = await s.patch(`/api/projects/${p.id}`, { name: 'Too late', revision: p.revision });
      expect(staleRename.statusCode).toBe(409);

      // A brief saved from another window is refused, and the response carries the latest brief.
      const staleBrief = await s.put(`/api/projects/${p.id}/brief`, { brief: { ...cur.brief, title: 'Other window' }, revision: 1 });
      expect(staleBrief.statusCode).toBe(409);
      expect(staleBrief.json().error.details).toMatchObject({ briefRevision: 2, brief: { title: 'Volcano Quest II' } });

      const renamed = await s.patch(`/api/projects/${p.id}`, { name: 'My volcano game', revision: cur.revision });
      expect(renamed.statusCode, renamed.body).toBe(200);
      await s.saveBrief(p.id, { title: 'Volcano Quest III' });
      cur = await s.project(p.id);
      expect(cur.name).toBe('My volcano game');
      expect(cur.brief.title).toBe('Volcano Quest III');
    });

    it('a project created with an explicit name keeps it when a brief title is first written', async () => {
      const p = await s.createProject('Named by the creator');
      await s.saveBrief(p.id, { title: 'Working title' });
      expect((await s.project(p.id)).name).toBe('Named by the creator');
    });

    it('rejects an invalid brief without saving it', async () => {
      const p = await s.createProject('Brief validation');
      const res = await s.put(`/api/projects/${p.id}/brief`, { brief: { ...p.brief, title: 't'.repeat(81) }, revision: 0 });
      expect(res.statusCode).toBe(400);
      expect((await s.project(p.id)).briefRevision).toBe(0);
    });
  });

  describe('duplicate', () => {
    let original: ProjectDetail;
    let copy: ProjectDetail;
    let originalVersion: GameVersion;
    let originalSlides: SourceSlide[];
    let originalBlueprint: BlueprintRevision;
    const originalIds = new Set<string>();

    const assetRows = (projectId: string) => s.app.db.all<AssetRow>('SELECT id, stored_dir, display_file, original_file, sha256 FROM assets WHERE project_id = ? ORDER BY sha256', [projectId]);

    beforeAll(async () => {
      const p = await s.createProject('Deck project');
      originalSlides = (await s.importDeck(p.id)).slides;
      const edited = await s.patch(`/api/slides/${originalSlides[1]!.id}`, { revision: 0, patch: { title: 'The airfield is a grid' } });
      expect(edited.statusCode, edited.body).toBe(200);
      originalSlides = await s.slides(p.id);
      originalBlueprint = await s.approvedManualBlueprint(p.id);
      originalVersion = await s.build(p.id);
      original = await s.project(p.id);
      expect(original.statusLabel).toBe('Playable');

      originalIds.add(original.id);
      for (const d of original.documents) originalIds.add(d.id);
      for (const sl of originalSlides) originalIds.add(sl.id);
      for (const a of assetRows(original.id)) originalIds.add(a.id);
      originalIds.add(originalBlueprint.id);
      originalIds.add(originalVersion.id);

      const res = await s.post(`/api/projects/${p.id}/duplicate`);
      expect(res.statusCode, res.body).toBe(201);
      copy = res.json().project as ProjectDetail;
    });

    it('creates a new project with new identifiers for every record', async () => {
      expect(copy.id).not.toBe(original.id);
      expect(copy.name).toBe('Deck project (copy)');
      expect(copy.slideCount).toBe(original.slideCount);
      expect(copy.currentVersionNumber).toBe(1);

      const copySlides = await s.slides(copy.id);
      expect(copySlides.map((x) => x.slideNumber)).toEqual(originalSlides.map((x) => x.slideNumber));
      expect(copySlides.map((x) => [x.extract.title, x.edits.title, x.hidden, x.included])).toEqual(originalSlides.map((x) => [x.extract.title, x.edits.title, x.hidden, x.included]));
      for (const sl of copySlides) expect(originalIds.has(sl.id), sl.id).toBe(false);
      expect(copy.documents).toHaveLength(original.documents.length);
      for (const d of copy.documents) expect(originalIds.has(d.id)).toBe(false);

      const copyAssets = assetRows(copy.id);
      expect(copyAssets.map((a) => a.sha256)).toEqual(assetRows(original.id).map((a) => a.sha256));
      for (const a of copyAssets) expect(originalIds.has(a.id)).toBe(false);

      // Slide edit history is copied with the slides.
      const history = (await s.get(`/api/slides/${copySlides[1]!.id}/history`)).json().changes as Array<{ field: string; after: unknown }>;
      expect(history.map((c) => [c.field, c.after])).toEqual([['title', 'The airfield is a grid']]);

      // Blueprints and versions point at the copy's own records only.
      const revisions = (await s.get(`/api/projects/${copy.id}/blueprints`)).json().revisions as BlueprintRevision[];
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.status).toBe('approved');
      expect(originalIds.has(revisions[0]!.id)).toBe(false);
      const copySlideIds = new Set(copySlides.map((x) => x.id));
      for (const scene of revisions[0]!.blueprint.scenes) for (const id of scene.sourceSlideIds) expect(copySlideIds.has(id), id).toBe(true);

      const version = (await s.get(`/api/versions/${copy.currentVersionId}`)).json().version as GameVersion;
      expect(originalIds.has(version.id)).toBe(false);
      expect(version.config.meta.projectId).toBe(copy.id);
      expect(version.blueprintRevisionId).toBe(revisions[0]!.id);
      const configText = JSON.stringify(version.config) + JSON.stringify(revisions[0]!.blueprint);
      for (const id of originalIds) expect(configText.includes(id), `copy still references ${id}`).toBe(false);

      // Conversation history and job logs are not copied.
      expect((await s.get(`/api/projects/${copy.id}/jobs`)).json().jobs).toEqual([]);
    });

    it('gives the copy private files: changing a copied file never changes the original', async () => {
      const origRows = assetRows(original.id);
      const copyRows = assetRows(copy.id);
      expect(copyRows.length).toBeGreaterThan(0);
      for (const [i, c] of copyRows.entries()) {
        const o = origRows[i]!;
        for (const file of ['display_file', 'original_file'] as const) {
          const of = path.join(s.dataDir, o.stored_dir, o[file]);
          const cf = path.join(s.dataDir, c.stored_dir, c[file]);
          expect(cf.startsWith(path.join(s.dataDir, 'projects', copy.id) + path.sep), cf).toBe(true);
          expect(fs.existsSync(cf)).toBe(true);
          expect(fs.statSync(cf).ino).not.toBe(fs.statSync(of).ino);
          expect(sha256(fs.readFileSync(cf))).toBe(sha256(fs.readFileSync(of)));
        }
      }

      const o = origRows[0]!;
      const c = copyRows[0]!;
      const origDisplay = path.join(s.dataDir, o.stored_dir, o.display_file);
      const before = sha256(fs.readFileSync(origDisplay));
      const servedBefore = (await s.get(`/api/assets/${o.id}/file`)).rawPayload;
      fs.writeFileSync(path.join(s.dataDir, c.stored_dir, c.display_file), Buffer.from('changed in the copy only'));
      expect(sha256(fs.readFileSync(origDisplay))).toBe(before);
      expect((await s.get(`/api/assets/${o.id}/file`)).rawPayload.equals(servedBefore)).toBe(true);
      expect((await s.get(`/api/assets/${c.id}/file`)).body).toBe('changed in the copy only');

      // The deck file is a private copy as well.
      const deckRow = (id: string) => s.app.db.get<{ stored_path: string }>('SELECT stored_path FROM source_documents WHERE project_id = ?', [id])!;
      const origDeck = path.join(s.dataDir, deckRow(original.id).stored_path);
      const copyDeck = path.join(s.dataDir, deckRow(copy.id).stored_path);
      expect(copyDeck).not.toBe(origDeck);
      expect(fs.statSync(copyDeck).ino).not.toBe(fs.statSync(origDeck).ino);
      expect(sha256(fs.readFileSync(copyDeck))).toBe(sha256(fs.readFileSync(origDeck)));
    });

    it('keeps approved blueprints and analyses fresh in the copy: nothing in the source changed', async () => {
      const freshness = async (projectId: string) => {
        const p = await s.project(projectId);
        const revisions = (await s.get(`/api/projects/${projectId}/blueprints`)).json().revisions as BlueprintRevision[];
        const analysis = (await s.get(`/api/projects/${projectId}/analysis`)).json().analysis as { stale: boolean; staleReason: string | null } | null;
        return {
          statusLabel: p.statusLabel,
          statusDetail: p.statusDetail,
          blueprints: revisions.map((r) => ({ number: r.number, status: r.status, stale: r.stale, staleReason: r.staleReason })),
          analysis: analysis ? { stale: analysis.stale, staleReason: analysis.staleReason } : null,
        };
      };
      // Deck project with a creator blueprint and a build.
      expect(await freshness(copy.id)).toEqual(await freshness(original.id));
      // The bundled sample (prepared analysis + approved blueprint + v1).
      const sample = await s.createSample();
      const dup = await s.post(`/api/projects/${sample.id}/duplicate`);
      expect(dup.statusCode, dup.body).toBe(201);
      expect(await freshness(dup.json().project.id)).toEqual(await freshness(sample.id));
    });

    it('the copy keeps working after the original is deleted (nothing is shared)', async () => {
      const del = await s.del(`/api/projects/${original.id}`, { confirmName: original.name });
      expect(del.statusCode, del.body).toBe(200);
      expect(fs.existsSync(path.join(s.dataDir, 'projects', original.id))).toBe(false);

      const p = await s.project(copy.id);
      expect(p.currentVersionNumber).toBe(1);
      expect((await s.get(`/api/projects/${copy.id}/preview-bundle`)).statusCode).toBe(200);
      const library = (await s.get(`/api/projects/${copy.id}/assets`)).json().assets as Array<{ id: string }>;
      expect(library.length).toBe(3);
      for (const a of library) {
        for (const variant of ['display', 'thumb', 'original']) {
          expect((await s.get(`/api/assets/${a.id}/file?variant=${variant}`)).statusCode, `${a.id} ${variant}`).toBe(200);
        }
      }
      expect((await s.get(`/api/sources/${p.documents[0]!.id}/file`)).statusCode).toBe(200);
      const exp = await s.post(`/api/projects/${copy.id}/exports`, { kind: 'playable' });
      expect(exp.statusCode, exp.body).toBe(201);
    });
  });

  describe('delete', () => {
    it('requires the exact project name and then removes every row and file of that project only', async () => {
      const keep = await s.createProject('Survivor');
      await s.importDeck(keep.id);
      const keepFiles = listFilesRecursive(path.join(s.dataDir, 'projects', keep.id));
      expect(keepFiles.length).toBeGreaterThan(0);

      const p = await s.createProject('Doomed project');
      const { slides } = await s.importDeck(p.id);
      expect((await s.patch(`/api/slides/${slides[0]!.id}`, { revision: 0, patch: { title: 'Edited before delete' } })).statusCode).toBe(200);
      await s.approvedManualBlueprint(p.id);
      await s.build(p.id);
      const exp = await s.post(`/api/projects/${p.id}/exports`, { kind: 'playable' });
      expect(exp.statusCode, exp.body).toBe(201);
      const jobIds = s.app.db.all<{ id: string }>('SELECT id FROM jobs WHERE project_id = ?', [p.id]).map((r) => r.id);
      const slideIds = slides.map((x) => x.id);
      expect(jobIds.length).toBeGreaterThan(0);
      const projectDir = path.join(s.dataDir, 'projects', p.id);
      expect(fs.existsSync(projectDir)).toBe(true);
      expect(fs.readdirSync(path.join(s.dataDir, 'exports')).some((f) => f.startsWith(`${p.id}-`))).toBe(true);

      const wrong = await s.del(`/api/projects/${p.id}`, { confirmName: 'Doomed' });
      expect(wrong.statusCode).toBe(400);
      expect((await s.get(`/api/projects/${p.id}`)).statusCode).toBe(200);
      expect(fs.existsSync(projectDir)).toBe(true);

      const res = await s.del(`/api/projects/${p.id}`, { confirmName: '  Doomed project ' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ deleted: p.id });

      expect((await s.get(`/api/projects/${p.id}`)).statusCode).toBe(404);
      expect((await list()).map((x) => x.id)).not.toContain(p.id);
      const rowsLeft: Record<string, number> = {};
      for (const table of ['projects', 'source_documents', 'source_slides', 'assets', 'analyses', 'blueprint_revisions', 'game_versions', 'proposals', 'chat_messages', 'jobs', 'exports']) {
        const col = table === 'projects' ? 'id' : 'project_id';
        rowsLeft[table] = s.app.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`, [p.id])!.c;
      }
      const inList = (ids: string[]) => ids.map(() => '?').join(',');
      rowsLeft.slide_changes = s.app.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM slide_changes WHERE slide_id IN (${inList(slideIds)})`, slideIds)!.c;
      rowsLeft.job_events = s.app.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM job_events WHERE job_id IN (${inList(jobIds)})`, jobIds)!.c;
      rowsLeft.job_stages = s.app.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM job_stages WHERE job_id IN (${inList(jobIds)})`, jobIds)!.c;
      expect(Object.entries(rowsLeft).filter(([, c]) => c > 0)).toEqual([]);

      expect(fs.existsSync(projectDir)).toBe(false);
      expect(fs.readdirSync(path.join(s.dataDir, 'exports')).filter((f) => f.startsWith(`${p.id}-`))).toEqual([]);

      // The other project is untouched.
      const survivor = await s.project(keep.id);
      expect(survivor.slideCount).toBe(9);
      expect(listFilesRecursive(path.join(s.dataDir, 'projects', keep.id))).toEqual(keepFiles);

      expect((await s.del(`/api/projects/${p.id}`, { confirmName: 'Doomed project' })).statusCode).toBe(404);
    });
  });
});
