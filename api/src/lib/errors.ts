/**
 * Single error envelope + typed error class (docs/01 §4, docs/04 §1).
 * The global handler maps zod → 400, AppError → its status, else 500.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: unknown;

  constructor(code: string, status: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export const errors = {
  badRequest: (msg: string, detail?: unknown) => new AppError('BAD_REQUEST', 400, msg, detail),
  unauthorized: (msg = 'Not authenticated') => new AppError('UNAUTHORIZED', 401, msg),
  forbidden: (msg = 'Not allowed') => new AppError('FORBIDDEN', 403, msg),
  notFound: (msg = 'Not found') => new AppError('NOT_FOUND', 404, msg),
  conflict: (msg: string, detail?: unknown) => new AppError('CONFLICT', 409, msg, detail),
  unprocessable: (msg: string, detail?: unknown) =>
    new AppError('UNPROCESSABLE', 422, msg, detail),
  unavailable: (msg = 'Service unavailable') => new AppError('UNAVAILABLE', 503, msg),
  // Pass an upstream (e.g. LockerHub) status + body straight through to the caller.
  upstream: (status: number, msg: string, detail?: unknown) =>
    new AppError('UPSTREAM', status >= 400 && status < 600 ? status : 502, msg, detail),
};

export interface ErrorEnvelope {
  error: { code: string; message: string; detail?: unknown };
}
