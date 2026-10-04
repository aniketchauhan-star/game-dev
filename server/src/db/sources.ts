import fs from 'node:fs';
import { ID_PREFIX, newId } from '@shared/schemas/common.ts';
import {
  effectiveSlideText,
  type ReviewStatus,
  type SlideChange,
  type SlideEdits,
  type SlideExtract,
  type SourceDocument,
  type SourceSlide,
  type VisualRef,
} from '@shared/schemas/source.ts';
import { conflict, notFound } from '../errors.ts';
import type { ExtractedSlide } from '../ingest/pptx.ts';
import { sha256, type Storage } from '../storage.ts';
import { nowIso, parseJson, type Db } from './db.ts';

// ───────────────────────────── documents ─────────────────────────────

interface DocumentRow {
  id: string;
  project_id: string;
  kind: SourceDocument['kind'];
  role: SourceDocument['role'];
  original_name: string;
  stored_path: string;
  size_bytes: number;
  sha256: string;
  status: SourceDocument['status'];
  page_count: number | null;
  slide_size_json: string | null;
  warnings_json: string;
  error: string | null;
  pages_json: string | null;
  created_at: string;
}

export function toDocument(r: DocumentRow): SourceDocument {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    role: r.role,
    originalName: r.original_name,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    status: r.status,
    pageCount: r.page_count,
    slideSize: parseJson(r.slide_size_json, null),
    warnings: parseJson<string[]>(r.warnings_json, []),
    error: r.error,
    createdAt: r.created_at,
  };
}

export function insertDocument(
  db: Db,
  d: { id: string; projectId: string; kind: SourceDocument['kind']; role: SourceDocument['role']; originalName: string; storedPath: string; sizeBytes: number; sha256: string; status: SourceDocument['status'] },
): void {
  db.run(
    `INSERT INTO source_documents (id, project_id, kind, role, original_name, stored_path, size_bytes, sha256, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.id, d.projectId, d.kind, d.role, d.originalName, d.storedPath, d.sizeBytes, d.sha256, d.status, nowIso()],
  );
}

export function updateDocument(
  db: Db,
  id: string,
  patch: Partial<{ status: SourceDocument['status']; pageCount: number | null; slideSize: { cx: number; cy: number } | null; warnings: string[]; error: string | null; pages: unknown }>,
): void {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.status !== undefined) (sets.push('status = ?'), params.push(patch.status));
  if (patch.pageCount !== undefined) (sets.push('page_count = ?'), params.push(patch.pageCount));
  if (patch.slideSize !== undefined) (sets.push('slide_size_json = ?'), params.push(JSON.stringify(patch.slideSize)));
  if (patch.warnings !== undefined) (sets.push('warnings_json = ?'), params.push(JSON.stringify(patch.warnings)));
  if (patch.error !== undefined) (sets.push('error = ?'), params.push(patch.error));
  if (patch.pages !== undefined) (sets.push('pages_json = ?'), params.push(JSON.stringify(patch.pages)));
  if (sets.length === 0) return;
  db.run(`UPDATE source_documents SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

export function getDocumentRow(db: Db, id: string): DocumentRow | undefined {
  return db.get<DocumentRow>('SELECT * FROM source_documents WHERE id = ?', [id]);
}

export function getDocument(db: Db, id: string): SourceDocument {
  const r = getDocumentRow(db, id);
  if (!r) throw notFound('Source document');
  return toDocument(r);
}

export function documentPages(db: Db, id: string): Array<{ number: number; text: string; width: number; height: number }> {
  return parseJson(getDocumentRow(db, id)?.pages_json, []);
}

export function listDocuments(db: Db, projectId: string): SourceDocument[] {
  return db.all<DocumentRow>('SELECT * FROM source_documents WHERE project_id = ? ORDER BY created_at', [projectId]).map(toDocument);
}

export function primaryDocument(db: Db, projectId: string): DocumentRow | undefined {
  return db.get<DocumentRow>("SELECT * FROM source_documents WHERE project_id = ? AND kind = 'pptx' ORDER BY created_at DESC LIMIT 1", [projectId]);
}

export function deleteDocument(db: Db, storage: Storage, id: string): void {
  const r = getDocumentRow(db, id);
  if (!r) throw notFound('Source document');
  db.tx(() => {
    if (r.kind === 'pdf' || r.kind === 'slide-images') {
      // Clear visual references that pointed at this document.
      for (const s of db.all<{ id: string; visual_ref_json: string | null }>('SELECT id, visual_ref_json FROM source_slides WHERE project_id = ?', [r.project_id])) {
        const ref = parseJson<VisualRef | null>(s.visual_ref_json, null);
        if (ref?.documentId === id) db.run('UPDATE source_slides SET visual_ref_json = NULL WHERE id = ?', [s.id]);
      }
    }
    db.run('DELETE FROM source_documents WHERE id = ?', [id]);
  });
  try {
    fs.rmSync(storage.abs(r.stored_path), { force: true });
  } catch {
    // file already gone
  }
}

// ───────────────────────────── slides ─────────────────────────────

interface SlideRow {
  id: string;
  project_id: string;
  document_id: string;
  slide_number: number;
  pptx_slide_id: number;
  part_name: string;
  hidden: number;
  included: number;
  extract_json: string;
  edits_json: string;
  locked_wording: number;
  required_example: number;
  review_status: ReviewStatus;
  visual_ref_json: string | null;
  content_hash: string;
  revision: number;
  updated_at: string;
}

const EMPTY_EDITS: SlideEdits = { title: null, blocks: {}, notes: null };

export function toSlide(r: SlideRow): SourceSlide {
  return {
    id: r.id,
    projectId: r.project_id,
    documentId: r.document_id,
    slideNumber: r.slide_number,
    pptxSlideId: r.pptx_slide_id,
    partName: r.part_name,
    hidden: r.hidden === 1,
    included: r.included === 1,
    extract: parseJson<SlideExtract>(r.extract_json, { title: '', layoutName: null, blocks: [], tables: [], equations: [], images: [], notes: [], warnings: [] }),
    edits: parseJson<SlideEdits>(r.edits_json, EMPTY_EDITS),
    lockedWording: r.locked_wording === 1,
    requiredExample: r.required_example === 1,
    reviewStatus: r.review_status,
    visualRef: parseJson<VisualRef | null>(r.visual_ref_json, null),
    contentHash: r.content_hash,
    revision: r.revision,
    updatedAt: r.updated_at,
  };
}

/** Initial review label: slides whose meaning depends on visuals we could not see start as “Missing visual reference”. */
function initialReviewStatus(extract: SlideExtract): ReviewStatus {
  const visualCodes = new Set(['chart', 'smartart', 'unsupported-image', 'media']);
  return extract.warnings.some((w) => visualCodes.has(w.code)) ? 'missing_visual' : 'needs_review';
}

export function insertSlides(db: Db, projectId: string, documentId: string, slides: ExtractedSlide[], imageAssets: Map<string, string>): void {
  for (const s of slides) {
    const extract: SlideExtract = {
      ...s.extract,
      images: s.extract.images.map((img) => ({ ...img, assetId: imageAssets.get(img.partName) ?? null })),
    };
    db.run(
      `INSERT INTO source_slides (id, project_id, document_id, slide_number, pptx_slide_id, part_name, hidden, included, extract_json, edits_json,
         review_status, content_hash, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        newId(ID_PREFIX.slide),
        projectId,
        documentId,
        s.slideNumber,
        s.pptxSlideId,
        s.partName,
        s.hidden ? 1 : 0,
        s.hidden ? 0 : 1,
        JSON.stringify(extract),
        JSON.stringify(EMPTY_EDITS),
        initialReviewStatus(extract),
        s.contentHash,
        nowIso(),
      ],
    );
  }
}

export function listSlides(db: Db, projectId: string): SourceSlide[] {
  return db.all<SlideRow>('SELECT * FROM source_slides WHERE project_id = ? ORDER BY slide_number', [projectId]).map(toSlide);
}

export function getSlide(db: Db, id: string): SourceSlide {
  const r = db.get<SlideRow>('SELECT * FROM source_slides WHERE id = ?', [id]);
  if (!r) throw notFound('Slide');
  return toSlide(r);
}

export interface SlidePatch {
  included?: boolean;
  title?: string | null;
  blocks?: Record<string, string[] | null>;
  notes?: string[] | null;
  lockedWording?: boolean;
  requiredExample?: boolean;
  reviewStatus?: ReviewStatus;
  visualRef?: VisualRef | null;
}

function recordChange(db: Db, slideId: string, field: string, before: unknown, after: unknown): void {
  db.run('INSERT INTO slide_changes (id, slide_id, field, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    newId(ID_PREFIX.slideEdit),
    slideId,
    field,
    JSON.stringify(before ?? null),
    JSON.stringify(after ?? null),
    nowIso(),
  ]);
}

/** Apply creator corrections with optimistic concurrency; every changed field is recorded in the history. */
export function updateSlide(db: Db, id: string, patch: SlidePatch, expectedRevision: number | null): SourceSlide {
  return db.tx(() => {
    const cur = getSlide(db, id);
    if (expectedRevision !== null && cur.revision !== expectedRevision) {
      throw conflict('This slide was changed elsewhere since you opened it.', 'Reload the slide to see the latest version, then reapply your change.', { current: cur });
    }
    const edits: SlideEdits = { ...cur.edits, blocks: { ...cur.edits.blocks } };
    let changed = false;
    if (patch.title !== undefined) {
      const next = patch.title === null || patch.title === cur.extract.title ? null : patch.title;
      if (next !== edits.title) {
        recordChange(db, id, 'title', edits.title ?? cur.extract.title, next ?? cur.extract.title);
        edits.title = next;
        changed = true;
      }
    }
    if (patch.blocks) {
      for (const [blockId, paragraphs] of Object.entries(patch.blocks)) {
        const original = cur.extract.blocks.find((b) => b.id === blockId);
        if (!original) continue;
        const originalText = original.paragraphs.map((p) => p.text);
        const before = edits.blocks[blockId] ?? originalText;
        const next = paragraphs === null || JSON.stringify(paragraphs) === JSON.stringify(originalText) ? null : paragraphs;
        if (JSON.stringify(next ?? originalText) !== JSON.stringify(before)) {
          recordChange(db, id, `block:${blockId}`, before, next ?? originalText);
          if (next === null) delete edits.blocks[blockId];
          else edits.blocks[blockId] = next;
          changed = true;
        }
      }
    }
    if (patch.notes !== undefined) {
      const next = patch.notes === null || JSON.stringify(patch.notes) === JSON.stringify(cur.extract.notes) ? null : patch.notes;
      if (JSON.stringify(next) !== JSON.stringify(edits.notes)) {
        recordChange(db, id, 'notes', edits.notes ?? cur.extract.notes, next ?? cur.extract.notes);
        edits.notes = next;
        changed = true;
      }
    }
    const flags: Array<[keyof SlidePatch, string, unknown, unknown]> = [
      ['included', 'included', cur.included, patch.included],
      ['lockedWording', 'locked_wording', cur.lockedWording, patch.lockedWording],
      ['requiredExample', 'required_example', cur.requiredExample, patch.requiredExample],
      ['reviewStatus', 'review_status', cur.reviewStatus, patch.reviewStatus],
    ];
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [key, column, before, after] of flags) {
      if (after === undefined || after === before) continue;
      recordChange(db, id, key, before, after);
      sets.push(`${column} = ?`);
      params.push(typeof after === 'boolean' ? (after ? 1 : 0) : (after as string));
      changed = true;
    }
    if (patch.visualRef !== undefined && JSON.stringify(patch.visualRef) !== JSON.stringify(cur.visualRef)) {
      recordChange(db, id, 'visualRef', cur.visualRef, patch.visualRef);
      sets.push('visual_ref_json = ?');
      params.push(patch.visualRef ? JSON.stringify(patch.visualRef) : null);
      changed = true;
    }
    if (!changed) return cur;
    sets.push('edits_json = ?', 'revision = revision + 1', 'updated_at = ?');
    params.push(JSON.stringify(edits), nowIso());
    db.run(`UPDATE source_slides SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    return getSlide(db, id);
  });
}

export function slideHistory(db: Db, slideId: string): SlideChange[] {
  return db
    .all<{ id: string; slide_id: string; field: string; before_json: string | null; after_json: string | null; created_at: string }>(
      'SELECT * FROM slide_changes WHERE slide_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200',
      [slideId],
    )
    .map((c) => ({ id: c.id, slideId: c.slide_id, field: c.field, before: parseJson(c.before_json, null), after: parseJson(c.after_json, null), createdAt: c.created_at }));
}

/** Restore the value a field had before a recorded change (recorded as a new change). */
export function revertSlideChange(db: Db, changeId: string): SourceSlide {
  const c = db.get<{ slide_id: string; field: string; before_json: string | null }>('SELECT slide_id, field, before_json FROM slide_changes WHERE id = ?', [changeId]);
  if (!c) throw notFound('Change');
  const before = parseJson<unknown>(c.before_json, null);
  const patch: SlidePatch = {};
  if (c.field === 'title') patch.title = before as string;
  else if (c.field.startsWith('block:')) patch.blocks = { [c.field.slice(6)]: before as string[] };
  else if (c.field === 'notes') patch.notes = before as string[];
  else if (c.field === 'included') patch.included = before as boolean;
  else if (c.field === 'lockedWording') patch.lockedWording = before as boolean;
  else if (c.field === 'requiredExample') patch.requiredExample = before as boolean;
  else if (c.field === 'reviewStatus') patch.reviewStatus = before as ReviewStatus;
  else if (c.field === 'visualRef') patch.visualRef = before as VisualRef | null;
  return updateSlide(db, c.slide_id, patch, null);
}

// ───────────────────────────── source revision & staleness ─────────────────────────────

export type SourceSnapshot = Record<string, { n: number; h: string; inc: boolean }>;

export function effectiveHash(slide: SourceSlide): string {
  const text = effectiveSlideText(slide);
  return sha256(
    JSON.stringify({
      t: text.title,
      b: text.blocks.map((b) => b.paragraphs),
      n: text.notes,
      tb: slide.extract.tables.map((t) => t.rows),
      eq: slide.extract.equations.map((e) => e.linear),
      lw: slide.lockedWording,
      rx: slide.requiredExample,
    }),
  );
}

export function sourceSnapshot(slides: SourceSlide[]): SourceSnapshot {
  const snap: SourceSnapshot = {};
  for (const s of slides) snap[s.id] = { n: s.slideNumber, h: effectiveHash(s), inc: s.included };
  return snap;
}

export function sourceRevisionOf(snapshot: SourceSnapshot): string {
  const entries = Object.entries(snapshot)
    .sort((a, b) => a[1].n - b[1].n)
    .filter(([, v]) => v.inc)
    .map(([id, v]) => `${id}:${v.h}`);
  return entries.length === 0 ? 'empty' : sha256(entries.join('|')).slice(0, 24);
}

/** Human explanation of what changed between two snapshots, e.g. “slide 4 edited; slide 6 excluded”. */
export function describeSnapshotDiff(before: SourceSnapshot, after: SourceSnapshot): string | null {
  const notes: string[] = [];
  for (const [id, b] of Object.entries(before)) {
    const a = after[id];
    if (!a) {
      if (b.inc) notes.push(`slide ${b.n} removed`);
      continue;
    }
    if (b.inc && !a.inc) notes.push(`slide ${a.n} excluded`);
    else if (!b.inc && a.inc) notes.push(`slide ${a.n} included`);
    else if (a.inc && a.h !== b.h) notes.push(`slide ${a.n} edited`);
  }
  for (const [id, a] of Object.entries(after)) if (!before[id] && a.inc) notes.push(`slide ${a.n} added`);
  if (notes.length === 0) return null;
  const shown = notes.slice(0, 6).join('; ');
  return `Source changed since this was generated: ${shown}${notes.length > 6 ? `; +${notes.length - 6} more` : ''}.`;
}

/**
 * Recompute the project's source revision. When it changes, dependent analyses
 * and blueprint revisions (including approved ones) are flagged stale with a
 * reason — they are never silently rewritten.
 */
export function refreshSourceRevision(db: Db, projectId: string): { revision: string; changed: boolean } {
  return db.tx(() => {
    const slides = listSlides(db, projectId);
    const snapshot = sourceSnapshot(slides);
    const revision = sourceRevisionOf(snapshot);
    const prev = db.get<{ source_revision: string }>('SELECT source_revision FROM projects WHERE id = ?', [projectId])?.source_revision ?? '';
    if (prev === revision) return { revision, changed: false };
    db.run('UPDATE projects SET source_revision = ?, updated_at = ? WHERE id = ?', [revision, nowIso(), projectId]);
    for (const a of db.all<{ id: string; source_revision: string; source_snapshot_json: string }>('SELECT id, source_revision, source_snapshot_json FROM analyses WHERE project_id = ?', [projectId])) {
      if (a.source_revision === revision) {
        db.run('UPDATE analyses SET stale = 0, stale_reason = NULL WHERE id = ?', [a.id]);
      } else {
        const reason = describeSnapshotDiff(parseJson(a.source_snapshot_json, {}), snapshot) ?? 'Source content changed since this analysis.';
        db.run('UPDATE analyses SET stale = 1, stale_reason = ? WHERE id = ?', [reason, a.id]);
      }
    }
    for (const b of db.all<{ id: string; source_revision: string; source_snapshot_json: string }>('SELECT id, source_revision, source_snapshot_json FROM blueprint_revisions WHERE project_id = ?', [projectId])) {
      if (b.source_revision === revision) {
        db.run('UPDATE blueprint_revisions SET stale = 0, stale_reason = NULL WHERE id = ?', [b.id]);
      } else {
        const reason = describeSnapshotDiff(parseJson(b.source_snapshot_json, {}), snapshot) ?? 'Source content changed since this blueprint.';
        db.run('UPDATE blueprint_revisions SET stale = 1, stale_reason = ? WHERE id = ?', [reason, b.id]);
      }
    }
    return { revision, changed: true };
  });
}

export function currentSnapshot(db: Db, projectId: string): { snapshot: SourceSnapshot; revision: string } {
  const snapshot = sourceSnapshot(listSlides(db, projectId));
  return { snapshot, revision: sourceRevisionOf(snapshot) };
}
