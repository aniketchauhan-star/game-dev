/**
 * Thin API client. Every mutating request carries the CSRF header the server
 * requires; errors come back as ApiError with a creator-facing message and hint.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint: string | null = null,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function parseError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; hint?: string | null; details?: unknown } } | null = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  const e = body?.error;
  if (e?.message) return new ApiError(res.status, e.code ?? 'error', e.message, e.hint ?? null, e.details ?? null);
  if (res.status === 502 || res.status === 504 || res.status === 503) {
    return new ApiError(res.status, 'server_unreachable', 'The NEXUS server is not responding.', 'Check that `npm run dev` (or `npm start`) is still running.');
  }
  return new ApiError(res.status, 'http_error', `Request failed (${res.status}).`);
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Nexus-CSRF'] = '1';
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: opts.signal, credentials: 'same-origin' });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Could not reach the NEXUS server.', 'Check that the studio server is running, then try again.');
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

/** Multipart upload with real progress (XMLHttpRequest exposes upload progress; fetch does not). */
export function upload<T>(path: string, form: FormData, onProgress: (p: UploadProgress) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('X-Nexus-CSRF', '1');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total });
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else {
        const e = (body as { error?: { code?: string; message?: string; hint?: string; details?: unknown } } | null)?.error;
        reject(new ApiError(xhr.status, e?.code ?? 'upload_failed', e?.message ?? `Upload failed (${xhr.status}).`, e?.hint ?? null, e?.details ?? null));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'The upload was interrupted.', 'Check that the studio server is running and try again.'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled.'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}

export function errorMessage(err: unknown): { message: string; hint: string | null } {
  if (err instanceof ApiError) return { message: err.message, hint: err.hint };
  if (err instanceof Error) return { message: err.message, hint: null };
  return { message: String(err), hint: null };
}
