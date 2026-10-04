import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { badRequest, HttpError } from '../errors.ts';

export function parse<T>(schema: z.ZodType<T>, data: unknown, what = 'request'): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest(`Invalid ${what}.`, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : undefined);
  }
  return r.data;
}

export function idempotencyKey(req: FastifyRequest): string | null {
  const raw = req.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) return null;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw badRequest('Invalid Idempotency-Key header.');
  return key;
}

export interface SavedUpload {
  tmpPath: string;
  originalName: string;
  size: number;
  sha256: string;
}

/** Stream one multipart file to a temporary file, enforcing the size limit and hashing as it goes. */
export async function saveFilePart(
  part: { file: NodeJS.ReadableStream & { truncated?: boolean }; filename: string },
  tmpPath: string,
  maxBytes: number,
): Promise<SavedUpload> {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new HttpError(413, 'too_large', `The file is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(part.file, meter, fs.createWriteStream(tmpPath, { flags: 'wx' }));
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    if (err instanceof HttpError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, 'too_large', `The file is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`);
    throw err;
  }
  if (part.file.truncated) {
    fs.rmSync(tmpPath, { force: true });
    throw new HttpError(413, 'too_large', `The file is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`);
  }
  const originalName = path.basename(part.filename || 'upload').replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'upload';
  return { tmpPath, originalName, size, sha256: hash.digest('hex') };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Send a file that has already been resolved inside an allowed root. */
export function sendFile(reply: FastifyReply, file: string, opts: { type?: string; cache?: string; disposition?: string } = {}) {
  const st = fs.statSync(file);
  reply.header('Content-Type', opts.type ?? contentType(file));
  reply.header('Content-Length', String(st.size));
  if (opts.cache) reply.header('Cache-Control', opts.cache);
  if (opts.disposition) reply.header('Content-Disposition', opts.disposition);
  return reply.send(fs.createReadStream(file));
}

export function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
