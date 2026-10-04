import './env.ts';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Asset } from '@shared/schemas/assets.ts';
import type { ProjectDetail } from '@shared/schemas/project.ts';
import type { GameVersion } from '@shared/schemas/records.ts';
import { multipart, sha256, Studio, studioHeaders, type MultipartPart, type Res } from './helpers.ts';

const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function wav(): Buffer {
  const data = Buffer.alloc(800);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(8000, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe('asset library', () => {
  let s: Studio;
  let sample: ProjectDetail;
  let v1: GameVersion;
  let png: Buffer;
  let png2: Buffer;

  beforeAll(async () => {
    s = await Studio.start();
    sample = await s.createSample();
    v1 = (await s.get(`/api/versions/${sample.currentVersionId}`)).json().version as GameVersion;
    png = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 30, g: 90, b: 200, alpha: 0.5 } } }).png().toBuffer();
    png2 = await sharp({ create: { width: 80, height: 80, channels: 4, background: { r: 220, g: 60, b: 20, alpha: 1 } } }).png().toBuffer();
  });

  afterAll(async () => {
    await s.close();
  });

  const uploadAssets = (projectId: string, files: Array<Omit<Extract<MultipartPart, { filename: string }>, 'name'>>, role?: string): Promise<Res> => {
    const parts: MultipartPart[] = [...(role ? [{ name: 'role', value: role }] : []), ...files.map((f) => ({ name: 'files', ...f }))];
    const { payload, contentType } = multipart(parts);
    return s.inject({ method: 'POST', url: `/api/projects/${projectId}/assets`, headers: { ...studioHeaders('POST'), 'content-type': contentType }, payload });
  };
  const assets = async (projectId: string) => (await s.get(`/api/projects/${projectId}/assets`)).json().assets as Asset[];

  it('checks files by content: images are kept; scripted or remote SVG and non-images are rejected with a reason', async () => {
    const before = (await assets(sample.id)).length;
    const res = await uploadAssets(
      sample.id,
      [
        { filename: 'badge.png', data: png, contentType: 'image/png' },
        { filename: 'evil.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>'), contentType: 'image/svg+xml' },
        { filename: 'remote.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image xlink:href="https://evil.example/x.png" width="10" height="10"/></svg>'), contentType: 'image/svg+xml' },
        { filename: 'handler.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="fetch(1)"><rect width="10" height="10"/></svg>'), contentType: 'image/svg+xml' },
        { filename: 'notes.png', data: Buffer.from('plain text with an image extension'), contentType: 'image/png' },
      ],
      'object',
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { created: Asset[]; rejected: Array<{ name: string; message: string; hint: string }> };
    expect(body.created).toHaveLength(1);
    expect(body.created[0]).toMatchObject({ name: 'badge', kind: 'image', role: 'object', source: 'uploaded', width: 64, height: 48, hasAlpha: true, sha256: sha256(png) });
    expect(body.rejected.map((r) => [r.name, r.message])).toEqual([
      ['evil.svg', 'SVG contains scripts.'],
      ['remote.svg', 'SVG references an external file or URL.'],
      ['handler.svg', 'SVG contains event handler attributes.'],
      ['notes.png', 'This file type is not a supported image format.'],
    ]);
    expect(body.rejected.every((r) => r.hint.length > 0)).toBe(true);
    expect((await assets(sample.id)).length).toBe(before + 1);
    expect(fs.readdirSync(path.join(s.dataDir, 'tmp'))).toEqual([]);

    // The same bytes again are not stored twice, and the creator is told which asset it matches.
    const again = await uploadAssets(sample.id, [{ filename: 'badge-copy.png', data: png }]);
    expect(again.json().created).toEqual([]);
    expect(again.json().duplicates).toEqual([{ name: 'badge-copy.png', existingId: body.created[0]!.id, existingName: 'badge', adopted: false }]);
    expect((await assets(sample.id)).length).toBe(before + 1);
  });

  it('rasterizes a safe SVG and serves only validated derivatives inline; originals are sandboxed attachments', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect width="120" height="60" fill="#1F5FAD"/><circle cx="30" cy="30" r="20" fill="#fff"/></svg>');
    const res = await uploadAssets(sample.id, [{ filename: 'logo.svg', data: svg, contentType: 'image/svg+xml' }], 'ui');
    expect(res.statusCode, res.body).toBe(201);
    const logo = res.json().created[0] as Asset;
    expect(logo).toMatchObject({ format: 'svg', mime: 'image/svg+xml', role: 'ui', metadata: { rasterizedFromSvg: true } });

    const display = await s.get(`/api/assets/${logo.id}/file?variant=display`);
    expect(display.statusCode).toBe(200);
    expect(display.headers['content-type']).toBe('image/png');
    expect(display.headers['content-security-policy']).toBe(ASSET_CSP);
    expect(display.rawPayload.subarray(1, 4).toString('latin1')).toBe('PNG');

    const thumb = await s.get(`/api/assets/${logo.id}/file?variant=thumb`);
    expect(thumb.headers['content-type']).toBe('image/webp');

    const original = await s.get(`/api/assets/${logo.id}/file?variant=original`);
    expect(original.statusCode).toBe(200);
    expect(original.headers['content-type']).toBe('application/octet-stream');
    expect(String(original.headers['content-disposition'])).toMatch(/^attachment; filename="logo\.svg"/);
    expect(original.headers['content-security-policy']).toBe(ASSET_CSP);
    expect(original.rawPayload.equals(svg)).toBe(true);

    expect((await s.get(`/api/assets/${logo.id}/file?variant=raw`)).statusCode).toBe(400);
    expect((await s.get('/api/assets/ast_doesnotexist/file')).statusCode).toBe(404);
  });

  it('refuses to delete an asset that a game version uses; an unused asset is deleted with its files', async () => {
    const usedId = Object.keys(v1.config.assets)[0]!;
    const refused = await s.del(`/api/assets/${usedId}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe('This asset is used by a game version, blueprint, design snapshot or screen map, so it cannot be deleted.');
    expect((await s.get(`/api/assets/${usedId}/file`)).statusCode).toBe(200);

    const badge = (await assets(sample.id)).find((a) => a.name === 'badge')!;
    const row = s.app.db.get<{ stored_dir: string }>('SELECT stored_dir FROM assets WHERE id = ?', [badge.id])!;
    const ok = await s.del(`/api/assets/${badge.id}`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await s.get(`/api/assets/${badge.id}/file`)).statusCode).toBe(404);
    expect(fs.existsSync(path.join(s.dataDir, row.stored_dir))).toBe(false);
  });

  it('replacing an asset used by the current version makes a new version that keeps its placement; older versions keep the old file', async () => {
    const characterId = v1.config.screens.title.characterAssetId!;
    expect(characterId).toBeTruthy();
    const placement = { scale: 1.5, rotation: 10, anchorX: 0.5, anchorY: 0.9, crop: null };
    const patched = await s.patch(`/api/assets/${characterId}`, { metadata: { placement } });
    expect(patched.statusCode, patched.body).toBe(200);

    const { payload, contentType } = multipart([{ name: 'file', filename: 'new-plane.png', data: png2, contentType: 'image/png' }]);
    const res = await s.inject({ method: 'POST', url: `/api/assets/${characterId}/replace`, headers: { ...studioHeaders('POST'), 'content-type': contentType }, payload });
    expect(res.statusCode, res.body).toBe(200);
    const fresh = res.json().asset as Asset;
    const v2 = res.json().version as GameVersion;
    expect(fresh.id).not.toBe(characterId);
    expect(fresh.metadata).toMatchObject({ placement, replacedFrom: characterId });
    expect(v2).toMatchObject({ number: 2, origin: 'manual-edit', parentVersionId: v1.id });
    expect(v2.config.screens.title.characterAssetId).toBe(fresh.id);
    expect(v2.config.assets[fresh.id]).toMatchObject({ placement, file: `assets/${fresh.id}.png`, width: 80, height: 80 });
    expect(v2.config.assets[characterId]).toBeUndefined();
    expect(JSON.stringify(v2.config)).not.toContain(characterId);

    // v1 is unchanged and its file is still there, so it stays playable.
    expect((await s.get(`/api/versions/${v1.id}`)).json().version.config).toEqual(v1.config);
    expect((await s.get(`/api/assets/${characterId}/file`)).statusCode).toBe(200);
    expect((await s.get(`/api/projects/${sample.id}/preview-bundle?versionId=${v1.id}`)).json().assets.every((a: { available: boolean }) => a.available)).toBe(true);
  });

  it('refuses to replace an image with audio and does not add the rejected file to the library', async () => {
    const currentId = (await s.project(sample.id)).currentVersionId!;
    const current = (await s.get(`/api/versions/${currentId}`)).json().version as GameVersion;
    const imageId = current.config.screens.title.characterAssetId!;
    const before = (await assets(sample.id)).map((a) => a.id).sort();
    const { payload, contentType } = multipart([{ name: 'file', filename: 'engine.wav', data: wav(), contentType: 'audio/wav' }]);
    const res = await s.inject({ method: 'POST', url: `/api/assets/${imageId}/replace`, headers: { ...studioHeaders('POST'), 'content-type': contentType }, payload });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatchObject({ code: 'kind_mismatch', message: 'Replace image with image, not audio.' });
    expect((await s.project(sample.id)).currentVersionId).toBe(current.id);
    const added = (await assets(sample.id)).filter((a) => !before.includes(a.id)).map((a) => ({ name: a.name, kind: a.kind, role: a.role }));
    expect(added, 'assets left in the library by the refused replacement').toEqual([]);
  });
});
