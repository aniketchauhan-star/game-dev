import './env.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Job } from '@shared/schemas/jobs.ts';
import type { SourceDocument } from '@shared/schemas/source.ts';
import { buildPptx, type BuildOptions, type SlideSpec } from '../../../fixtures/scripts/pptx-builder.ts';
import { runOnce } from '../../../server/src/jobs/runner.ts';
import {
  listFilesRecursive,
  multipart,
  oleFile,
  SAMPLE_HIDDEN_SLIDE_NUMBER,
  SAMPLE_PART_ORDER,
  SAMPLE_TITLES_IN_ORDER,
  sampleDeck,
  sha256,
  Studio,
  studioHeaders,
} from './helpers.ts';

const TINY_SLIDES: SlideSpec[] = [
  { partNumber: 1, layout: 'title', title: 'Tiny deck', subtitle: 'Upload safety checks' },
  { partNumber: 2, layout: 'content', title: 'One idea', bullets: ['A single bullet.'], notes: ['A private teacher note.'] },
];
const tinyDeck = (extra: Partial<BuildOptions> = {}): Buffer => buildPptx({ slides: TINY_SLIDES, ...extra });
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

describe('deck upload → extract_pptx job → slides', () => {
  let s: Studio;

  beforeAll(async () => {
    s = await Studio.start();
  });

  afterAll(async () => {
    await s.close();
  });

  const tmpFiles = () => fs.readdirSync(path.join(s.dataDir, 'tmp'));

  describe('the bundled sample deck', () => {
    let projectId: string;
    let jobId: string;
    let documentId: string;

    beforeAll(async () => {
      projectId = (await s.createProject('Upload target')).id;
    });

    it('stores the upload as a document and queues an extract_pptx job (202)', async () => {
      const deck = sampleDeck();
      const res = await s.upload(projectId, { filename: 'air-traffic-control.pptx', data: deck, contentType: PPTX_MIME });
      expect(res.statusCode, res.body).toBe(202);
      const { document, job } = res.json() as { document: SourceDocument; job: Job };
      documentId = document.id;
      jobId = job.id;
      expect(document).toMatchObject({ projectId, kind: 'pptx', role: 'primary', status: 'stored', originalName: 'air-traffic-control.pptx', sizeBytes: deck.length, sha256: sha256(deck) });
      expect(job).toMatchObject({ projectId, type: 'extract_pptx', status: 'queued', mode: 'local', attempt: 0, maxAttempts: 2 });

      const stored = path.join(s.dataDir, 'projects', projectId, 'sources', document.id, 'original.pptx');
      expect(sha256(fs.readFileSync(stored))).toBe(sha256(deck));
      expect(tmpFiles()).toEqual([]);

      const p = await s.project(projectId);
      expect(p.state).toBe('extracting');
      expect(p.activeJobs.map((j) => j.id)).toEqual([job.id]);
    });

    it('is processed by the worker process (separate connection) exactly once', async () => {
      expect(await runOnce(s.worker, 'upload-worker')).toBe(true);
      expect(await runOnce(s.worker, 'upload-worker')).toBe(false);
      const { job, events } = await s.job(jobId);
      expect(job.status).toBe('succeeded');
      expect(job.attempt).toBe(1);
      expect(job.result).toMatchObject({ slides: 9, hidden: 1, withNotes: 9, images: 3 });
      const messages = events.map((e) => e.message);
      expect(messages[0]).toBe('Queued');
      expect(messages).toContain('Started');
      expect(messages).toContain('Reading the PowerPoint package');
      expect(messages.some((m) => /^Extracted 9 slides \(1 hidden, 9 with speaker notes, 3 images/.test(m))).toBe(true);
      expect(messages.at(-1)).toBe('Completed');

      const p = await s.project(projectId);
      expect(p).toMatchObject({ state: 'needs_review', slideCount: 9, statusDetail: '9 slides imported', activeJobs: [] });
      expect(p.documents.find((d) => d.id === documentId)).toMatchObject({ status: 'ready', pageCount: 9, error: null });
    });

    it('returns slides in presentation order (not file order) with the hidden slide excluded and notes kept', async () => {
      const slides = await s.slides(projectId);
      expect(slides.map((x) => x.extract.title)).toEqual([...SAMPLE_TITLES_IN_ORDER]);
      expect(slides.map((x) => x.slideNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(slides.map((x) => x.partName)).toEqual(SAMPLE_PART_ORDER.map((n) => `ppt/slides/slide${n}.xml`));
      expect(slides.map((x) => x.pptxSlideId)).toEqual(SAMPLE_PART_ORDER.map((n) => 256 + n));

      const hidden = slides.filter((x) => x.hidden);
      expect(hidden.map((x) => x.slideNumber)).toEqual([SAMPLE_HIDDEN_SLIDE_NUMBER]);
      expect(hidden[0]!.included).toBe(false);
      expect(slides.filter((x) => !x.hidden).every((x) => x.included)).toBe(true);

      expect(slides[0]!.extract.notes).toEqual(['Hook: ask how air traffic controllers say exactly where an aircraft is.', 'Today learners guide aircraft using ordered pairs.']);
      expect(slides.every((x) => x.extract.notes.length > 0)).toBe(true);
      expect(slides[3]!.extract.tables[0]!.rows[0]).toEqual(['Quadrant', 'x', 'y']);
      expect(slides[7]!.extract.equations).toHaveLength(1);

      // The three deck images became assets, linked from their slides.
      const assets = (await s.get(`/api/projects/${projectId}/assets`)).json().assets as Array<{ id: string; source: string; kind: string }>;
      expect(assets).toHaveLength(3);
      expect(assets.every((a) => a.source === 'extracted' && a.kind === 'image')).toBe(true);
      const linked = slides.flatMap((x) => x.extract.images.map((i) => i.assetId));
      expect(new Set(linked)).toEqual(new Set(assets.map((a) => a.id)));

      // What an analysis would send: the hidden slide is not included.
      const preview = (await s.get(`/api/projects/${projectId}/ai-preview`)).json();
      expect(preview.slides.filter((x: { included: boolean }) => x.included)).toHaveLength(8);
      expect(preview.slides[SAMPLE_HIDDEN_SLIDE_NUMBER - 1]).toMatchObject({ hidden: true, included: false, characters: 0 });
    });

    it('serves the original deck only as a sandboxed attachment', async () => {
      const res = await s.get(`/api/sources/${documentId}/file`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="air-traffic-control\.pptx"/);
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(sha256(res.rawPayload)).toBe(sha256(sampleDeck()));
    });

    it('replacing the deck needs explicit confirmation; then slides are replaced and blueprints go stale', async () => {
      const approved = await s.approvedManualBlueprint(projectId);
      const oldFile = path.join(s.dataDir, 'projects', projectId, 'sources', documentId, 'original.pptx');

      const unconfirmed = await s.upload(projectId, { filename: 'tiny.pptx', data: tinyDeck() });
      expect(unconfirmed.statusCode).toBe(409);
      expect(unconfirmed.json().error.message).toBe('This project already has a deck.');
      expect(unconfirmed.json().error.hint).toMatch(/Replace deck/);
      expect((await s.slides(projectId))).toHaveLength(9);
      expect(tmpFiles()).toEqual([]);

      const replaced = await s.upload(projectId, { filename: 'tiny.pptx', data: tinyDeck() }, { replace: '1' });
      expect(replaced.statusCode, replaced.body).toBe(202);
      await s.runJobs();
      const slides = await s.slides(projectId);
      expect(slides.map((x) => x.extract.title)).toEqual(['Tiny deck', 'One idea']);
      const p = await s.project(projectId);
      expect(p.documents.map((d) => d.originalName)).toEqual(['tiny.pptx']);
      expect(fs.existsSync(oldFile)).toBe(false);

      const rev = (await s.get(`/api/blueprints/${approved.id}`)).json().revision;
      expect(rev.status).toBe('approved');
      expect(rev.stale).toBe(true);
      expect(rev.staleReason).toMatch(/^Source changed since this was generated: .*slide 1 removed/);
    });
  });

  describe('rejected uploads', () => {
    it('refuses legacy, macro-enabled, Keynote, non-presentation and empty files up front', async () => {
      const cases = [
        { filename: 'lesson.ppt', data: oleFile(), status: 415, code: 'legacy_ppt', message: /Legacy \.ppt files are not supported/ },
        { filename: 'lesson.pps', data: oleFile(), status: 415, code: 'legacy_ppt', message: /Legacy \.ppt/ },
        { filename: 'lesson.pptm', data: tinyDeck(), status: 415, code: 'macro', message: /Macro-enabled presentations are not accepted/ },
        { filename: 'lesson.ppsm', data: tinyDeck(), status: 415, code: 'macro', message: /Macro-enabled/ },
        { filename: 'lesson.key', data: tinyDeck(), status: 415, code: 'keynote', message: /Keynote/ },
        { filename: 'notes.pptx', data: Buffer.from('plain text pretending to be a deck'), status: 415, code: 'not_pptx', message: /not a PowerPoint/ },
        { filename: 'scan.pptx', data: Buffer.from('%PDF-1.7\n%âã\n1 0 obj\n<<>>\nendobj\n'), status: 415, code: 'not_pptx', message: /not a PowerPoint/ },
        { filename: 'empty.pptx', data: Buffer.alloc(0), status: 400, code: 'empty', message: /empty/ },
      ];
      for (const c of cases) {
        const p = await s.createProject(`Reject ${c.filename}`);
        const res = await s.upload(p.id, { filename: c.filename, data: c.data });
        expect(res.statusCode, `${c.filename}: ${res.body}`).toBe(c.status);
        const err = res.json().error;
        expect(err.code, c.filename).toBe(c.code);
        expect(err.message, c.filename).toMatch(c.message);
        if (c.status === 415) expect(err.hint, c.filename).toBeTruthy();
        expect((await s.project(p.id)).documents, c.filename).toEqual([]);
        expect((await s.get(`/api/projects/${p.id}/jobs`)).json().jobs, c.filename).toEqual([]);
        expect(listFilesRecursive(path.join(s.dataDir, 'projects', p.id)), c.filename).toEqual([]);
      }
      expect(tmpFiles()).toEqual([]);
    });

    it('refuses requests without exactly one file', async () => {
      const p = await s.createProject('Malformed uploads');
      const noFile = multipart([{ name: 'kind', value: 'pptx' }]);
      const r1 = await s.inject({ method: 'POST', url: `/api/projects/${p.id}/sources`, headers: { ...studioHeaders('POST'), 'content-type': noFile.contentType }, payload: noFile.payload });
      expect(r1.statusCode).toBe(400);
      expect(r1.json().error.code).toBe('no_file');

      const two = multipart([
        { name: 'file', filename: 'a.pptx', data: tinyDeck() },
        { name: 'file', filename: 'b.pptx', data: tinyDeck() },
      ]);
      const r2 = await s.inject({ method: 'POST', url: `/api/projects/${p.id}/sources`, headers: { ...studioHeaders('POST'), 'content-type': two.contentType }, payload: two.payload });
      expect(r2.statusCode).toBe(400);
      expect(r2.json().error.code).toBe('one_file');

      const json = await s.post(`/api/projects/${p.id}/sources`, { file: 'not multipart' });
      expect(json.statusCode).toBe(415);
      expect(json.json().error.code).toBe('not_multipart');

      expect((await s.project(p.id)).documents).toEqual([]);
      expect(tmpFiles()).toEqual([]);
      expect((await s.upload('prj_doesnotexist1', { filename: 'a.pptx', data: tinyDeck() })).statusCode).toBe(404);
    });

    const TRAVERSAL_NAME = `nexus-it-traversal-${crypto.randomBytes(6).toString('hex')}.txt`;
    const hostile = [
      { label: 'password-protected (OLE) file named .pptx', filename: 'protected.pptx', data: () => oleFile(), code: 'pptx_ole', message: /password-protected or encrypted/ },
      { label: 'macro-enabled package renamed to .pptx', filename: 'renamed.pptx', data: () => tinyDeck({ mainContentType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml' }), code: 'pptx_macro', message: /Macro-enabled presentations/ },
      { label: 'package carrying a VBA project', filename: 'vba.pptx', data: () => tinyDeck({ extraEntries: [{ name: 'ppt/vbaProject.bin', data: Buffer.from('VBA') }] }), code: 'pptx_macro', message: /Macro-enabled presentations/ },
      { label: 'ZIP with a ../ traversal entry', filename: 'traversal.pptx', data: () => tinyDeck({ extraEntries: [{ name: `../../${TRAVERSAL_NAME}`, data: 'pwned' }] }), code: 'pptx_traversal', message: /Rejected unsafe archive entry/ },
      { label: 'ZIP with an absolute-path entry', filename: 'absolute.pptx', data: () => tinyDeck({ extraEntries: [{ name: `/tmp/${TRAVERSAL_NAME}`, data: 'pwned' }] }), code: 'pptx_traversal', message: /Rejected unsafe archive entry/ },
      { label: 'ZIP with a symbolic link entry', filename: 'symlink.pptx', data: () => tinyDeck({ extraEntries: [{ name: 'ppt/media/link.png', data: '/etc/passwd', symlink: true }] }), code: 'pptx_symlink', message: /symbolic link/ },
      { label: 'ZIP with an encrypted entry', filename: 'encrypted-entry.pptx', data: () => tinyDeck({ extraEntries: [{ name: 'ppt/media/secret.bin', data: 'x', encryptedFlag: true }] }), code: 'pptx_encrypted-entry', message: /encrypted entries/ },
      { label: 'ZIP entry declaring a 2 GB expansion', filename: 'bomb.pptx', data: () => tinyDeck({ extraEntries: [{ name: 'ppt/media/bomb.bin', data: 'x', declaredSize: 2_000_000_000 }] }), code: 'pptx_too-large', message: /limit/ },
      { label: 'Word package renamed to .pptx', filename: 'document.pptx', data: () => tinyDeck({ mainContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' }), code: 'pptx_not-presentation', message: /not a PowerPoint presentation/ },
      { label: 'truncated ZIP', filename: 'truncated.pptx', data: () => tinyDeck().subarray(0, 600), code: 'pptx_not-zip', message: /not a valid ZIP/ },
    ];

    it('a control deck built the same way imports fine (so the failures below come from the hostile part)', async () => {
      const p = await s.createProject('Control deck');
      const { slides } = await s.importDeck(p.id, tinyDeck(), 'control.pptx');
      expect(slides.map((x) => x.extract.title)).toEqual(['Tiny deck', 'One idea']);
    });

    for (const h of hostile) {
      it(`fails the extraction job with a clear, non-retryable message: ${h.label}`, async () => {
        const p = await s.createProject(`Hostile: ${h.label}`);
        const up = await s.upload(p.id, { filename: h.filename, data: h.data() });
        expect(up.statusCode, up.body).toBe(202);
        const jobId = up.json().job.id as string;
        await s.runJobs();
        const { job, events } = await s.job(jobId);
        expect(job.status).toBe('failed');
        expect(job.error).toMatchObject({ code: h.code, retryable: false });
        expect(job.error!.message).toMatch(h.message);
        expect(events.at(-1)).toMatchObject({ type: 'error' });
        expect(events.at(-1)!.message).toMatch(/^Failed: /);

        const proj = await s.project(p.id);
        expect(proj.documents[0]).toMatchObject({ status: 'failed' });
        expect(proj.documents[0]!.error).toBeTruthy();
        expect(proj.slideCount).toBe(0);
        expect(proj.statusLabel).toBe('Needs attention');
        expect(proj.statusDetail).toMatch(/^Import failed: /);
        expect(proj.state).toBe('failed');
      });
    }

    it('never writes archive entries to disk (no traversal target appears anywhere)', () => {
      const everywhere = [...listFilesRecursive(s.dataDir), ...fs.readdirSync(os.tmpdir()).map((n) => path.join(os.tmpdir(), n))];
      expect(everywhere.filter((f) => f.includes(TRAVERSAL_NAME))).toEqual([]);
      expect(fs.existsSync(path.join('/tmp', TRAVERSAL_NAME))).toBe(false);
    });
  });

  describe('upload size limit', () => {
    let small: Studio;

    beforeAll(async () => {
      small = await Studio.start({ limits: { maxUploadBytes: 1024 * 1024, maxAssetBytes: 1024 * 1024 } });
    });

    afterAll(async () => {
      await small.close();
    });

    const padded = (bytes: number) => tinyDeck({ extraEntries: [{ name: 'ppt/media/padding.bin', data: crypto.randomBytes(bytes), method: 'store' }] });

    it('refuses a deck above the limit with 413 and leaves nothing behind', async () => {
      expect((await small.get('/api/health')).json().limits.maxUploadBytes).toBe(1024 * 1024);
      const p = await small.createProject('Too big');
      const data = padded(1536 * 1024);
      expect(data.length).toBeGreaterThan(1024 * 1024);
      const res = await small.upload(p.id, { filename: 'big.pptx', data });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('too_large');
      expect(res.json().error.message).toMatch(/1 MB/);
      expect((await small.project(p.id)).documents).toEqual([]);
      expect((await small.get(`/api/projects/${p.id}/jobs`)).json().jobs).toEqual([]);
      expect(fs.readdirSync(path.join(small.dataDir, 'tmp'))).toEqual([]);
      expect(listFilesRecursive(path.join(small.dataDir, 'projects'))).toEqual([]);
    });

    it('accepts a deck just under the limit', async () => {
      const p = await small.createProject('Fits');
      const data = padded(900 * 1024);
      expect(data.length).toBeLessThan(1024 * 1024);
      const { slides } = await small.importDeck(p.id, data, 'fits.pptx');
      expect(slides).toHaveLength(2);
    });
  });
});
