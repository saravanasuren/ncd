/**
 * Global error handler → the one error envelope (docs/04 §1).
 * zod → 400, AppError → its status, everything else → 500.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, type ErrorEnvelope } from '../lib/errors.js';
import { alertOps } from '../lib/alerts.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  const body: ErrorEnvelope = { error: { code: 'NOT_FOUND', message: 'Route not found' } };
  res.status(404).json(body);
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    const body: ErrorEnvelope = {
      error: { code: 'VALIDATION', message: 'Invalid request', detail: err.flatten() },
    };
    res.status(400).json(body);
    return;
  }
  if (err instanceof AppError) {
    const body: ErrorEnvelope = {
      error: { code: err.code, message: err.message, detail: err.detail },
    };
    // A 4xx is a caller mistake — a bad PAN, a stale form — and mailing those
    // would bury the real faults. Only OUR failures (5xx) are alerts, and an
    // upstream 502/503 counts: LockerHub being down is something ops must hear
    // about even though the throw came from a library.
    if (err.status >= 500) void alertOps(`${err.status} ${err.code} on ${req.method} ${req.path}`, describe(err, req));
    res.status(err.status).json(body);
    return;
  }
  // Unknown — log, alert, and return a generic 500 (never leak internals).
  console.error('[error] unhandled:', err);
  void alertOps(`500 on ${req.method} ${req.path}`, describe(err, req));
  const body: ErrorEnvelope = { error: { code: 'INTERNAL', message: 'Internal server error' } };
  res.status(500).json(body);
};

/**
 * What ops need to act: which call, who made it, and the stack. Query strings
 * and bodies are deliberately NOT included — they carry PAN, bank accounts and
 * phone numbers, and an alert mail is not a place to put those.
 */
function describe(err: unknown, req: { method: string; path: string; user?: { id: number; email: string } }): string {
  const e = err instanceof Error ? err : new Error(String(err));
  return [
    `${e.message}`,
    '',
    `Request: ${req.method} ${req.path}`,
    `User:    ${req.user ? `${req.user.email} (id ${req.user.id})` : 'unauthenticated'}`,
    '',
    e.stack ?? '(no stack)',
  ].join('\n');
}

/** Wrap an async handler so thrown errors reach the error handler. */
export function asyncHandler<T extends RequestHandler>(fn: T): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
