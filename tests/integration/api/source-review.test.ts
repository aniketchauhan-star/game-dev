import './env.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlueprintRevision } from '@shared/schemas/blueprint.ts';
import type { SlideChange, SourceSlide } from '@shared/schemas/source.ts';
import { Studio } from './helpers.ts';

describe('source review', () => {
  let s: Studio;
  let projectId: string;
  let slides: SourceSlide[];
  let originalRevision: string;

  beforeAll(async () => {
    s = await Studio.start();
    projectId = (await s.createProject('Source review')).id;
    slides = (await s.importDeck(projectId)).slides;
    originalRevision = (await s.project(projectId)).sourceRevision;
    expect(originalRevision).toMatch(/^[0-9a-f]{24}$/);
  });

  afterAll(async () => {
    await s.close();
  });

  const history = async (slideId: string) => {
    const res = await s.get(`/api/slides/${slideId}/history`);
    expect(res.statusCode).toBe(200);
    return res.json().changes as SlideChange[];
  };
  const patchSlide = (slideId: string, revision: number | null, patch: Record<string, unknown>) => s.patch(`/api/slides/${slideId}`, { revision, patch });

  it('editing slide text records history and changes the source revision', async () => {
    const slide = slides[1]!;
    const body = slide.extract.blocks.find((b) => b.role === 'body')!;
    const originalBody = body.paragraphs.map((p) => p.text);

    const r1 = await patchSlide(slide.id, slide.revision, { title: 'The airfield is a grid' });
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json().slide).toMatchObject({ revision: 1, edits: { title: 'The airfield is a grid' }, extract: { title: 'The airfield is a coordinate plane' } });
    expect(r1.json().sourceChanged).toBe(true);
    const rev1 = r1.json().sourceRevision as string;
    expect(rev1).not.toBe(originalRevision);
    expect((await s.project(projectId)).sourceRevision).toBe(rev1);

    const r2 = await patchSlide(slide.id, 1, { blocks: { [body.id]: ['The x-axis runs across.', 'The y-axis runs up.'] } });
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json().slide.revision).toBe(2);
    expect(r2.json().sourceChanged).toBe(true);
    expect(r2.json().sourceRevision).not.toBe(rev1);

    // Optimistic concurrency on slides.
    const stale = await patchSlide(slide.id, 1, { title: 'Lost update' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details.current.revision).toBe(2);

    // History, newest first, with before/after values.
    let changes = await history(slide.id);
    expect(changes.map((c) => [c.field, c.before, c.after])).toEqual([
      [`block:${body.id}`, originalBody, ['The x-axis runs across.', 'The y-axis runs up.']],
      ['title', 'The airfield is a coordinate plane', 'The airfield is a grid'],
    ]);

    // Saving the same value is not a change.
    const noop = await patchSlide(slide.id, 2, { title: 'The airfield is a grid' });
    expect(noop.json()).toMatchObject({ sourceChanged: false, slide: { revision: 2 } });
    expect(await history(slide.id)).toHaveLength(2);

    // Edited text is what analysis and building see.
    const preview = (await s.get(`/api/projects/${projectId}/ai-preview`)).json();
    expect(preview.slides[1].title).toBe('The airfield is a grid');

    // Reverting is recorded as a new change; reverting everything restores the original source revision.
    const titleChange = changes.find((c) => c.field === 'title')!;
    const reverted = await s.post(`/api/slide-changes/${titleChange.id}/revert`);
    expect(reverted.statusCode, reverted.body).toBe(200);
    expect(reverted.json().slide.edits.title).toBeNull();
    changes = await history(slide.id);
    expect(changes).toHaveLength(3);
    expect(changes[0]).toMatchObject({ field: 'title', before: 'The airfield is a grid', after: 'The airfield is a coordinate plane' });
    const blockChange = changes.find((c) => c.field === `block:${body.id}`)!;
    expect((await s.post(`/api/slide-changes/${blockChange.id}/revert`)).statusCode).toBe(200);
    expect((await s.project(projectId)).sourceRevision).toBe(originalRevision);
  });

  it('records review status, wording locks and inclusion; only content-relevant changes move the source revision', async () => {
    const slide = (await s.slides(projectId))[2]!;
    const reviewed = await patchSlide(slide.id, slide.revision, { reviewStatus: 'verified' });
    expect(reviewed.json()).toMatchObject({ sourceChanged: false, slide: { reviewStatus: 'verified' } });
    const locked = await patchSlide(slide.id, slide.revision + 1, { lockedWording: true });
    expect(locked.json()).toMatchObject({ sourceChanged: true, slide: { lockedWording: true } });
    const unlocked = await patchSlide(slide.id, slide.revision + 2, { lockedWording: false });
    expect(unlocked.json().sourceRevision).toBe(originalRevision);
    expect((await history(slide.id)).map((c) => c.field)).toEqual(['lockedWording', 'lockedWording', 'reviewStatus']);
  });

  describe('staleness after approval', () => {
    let approved: BlueprintRevision;

    beforeAll(async () => {
      approved = await s.approvedManualBlueprint(projectId);
      expect(approved.stale).toBe(false);
      expect(approved.sourceRevision).toBe(originalRevision);
    });

    const blueprint = async (id: string) => (await s.get(`/api/blueprints/${id}`)).json().revision as BlueprintRevision;

    it('editing a source slide marks the approved blueprint stale with a reason, without rewriting it', async () => {
      const slide4 = (await s.slides(projectId))[3]!;
      const edit = await patchSlide(slide4.id, slide4.revision, { title: 'Quadrants I to IV' });
      expect(edit.json().sourceChanged).toBe(true);

      let rev = await blueprint(approved.id);
      expect(rev).toMatchObject({ status: 'approved', stale: true, staleReason: 'Source changed since this was generated: slide 4 edited.' });
      expect(rev.blueprint).toEqual(approved.blueprint);
      expect(rev.sourceRevision).toBe(approved.sourceRevision);
      const p = await s.project(projectId);
      expect(p.statusLabel).toBe('Needs attention');
      expect(p.statusDetail).toBe('Source changed after blueprint r1 was approved.');

      const slide5 = (await s.slides(projectId))[4]!;
      expect((await patchSlide(slide5.id, slide5.revision, { included: false })).json().sourceChanged).toBe(true);
      rev = await blueprint(approved.id);
      expect(rev.staleReason).toBe('Source changed since this was generated: slide 4 edited; slide 5 excluded.');

      // Undoing the edits makes the approved blueprint current again.
      const titleChange = (await history(slide4.id)).find((c) => c.field === 'title')!;
      expect((await s.post(`/api/slide-changes/${titleChange.id}/revert`)).statusCode).toBe(200);
      expect((await patchSlide(slide5.id, slide5.revision + 1, { included: true })).statusCode).toBe(200);
      rev = await blueprint(approved.id);
      expect(rev).toMatchObject({ stale: false, staleReason: null, status: 'approved' });
      expect((await s.project(projectId)).statusLabel).toBe('Blueprint approved');
    });

    it('a new draft can acknowledge source changes, which refreshes its source snapshot', async () => {
      const created = await s.post(`/api/blueprints/${approved.id}/draft`);
      expect(created.statusCode, created.body).toBe(201);
      const draft = created.json().revision as BlueprintRevision;
      expect(draft).toMatchObject({ status: 'draft', parentId: approved.id, stale: false });

      const slide2 = (await s.slides(projectId))[1]!;
      await patchSlide(slide2.id, slide2.revision, { notes: ['Rewritten teacher note.'] });
      expect((await blueprint(draft.id)).stale).toBe(true);
      expect((await blueprint(approved.id)).staleReason).toBe('Source changed since this was generated: slide 2 edited.');

      const ack = await s.put(`/api/blueprints/${draft.id}`, { blueprint: draft.blueprint, revision: draft.revision, acknowledgeSourceChanges: true });
      expect(ack.statusCode, ack.body).toBe(200);
      expect(ack.json().revision).toMatchObject({ stale: false, staleReason: null, sourceRevision: (await s.project(projectId)).sourceRevision });
      // The approved revision keeps its original snapshot and stays flagged.
      expect((await blueprint(approved.id)).stale).toBe(true);
    });
  });
});
