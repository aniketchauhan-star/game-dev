/** Errors that map to HTTP responses with a creator-facing message and recovery hint. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} was not found.`);

export const conflict = (message: string, hint?: string, details?: unknown) => new HttpError(409, 'conflict', message, hint, details);

export const badRequest = (message: string, hint?: string, details?: unknown) => new HttpError(400, 'bad_request', message, hint, details);
