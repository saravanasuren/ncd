/**
 * Global error handler → the one error envelope (docs/04 §1).
 * zod → 400, AppError → its status, everything else → 500.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, type ErrorEnvelope } from '../lib/errors.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  const body: ErrorEnvelope = { error: { code: 'NOT_FOUND', message: 'Route not found' } };
  res.status(404).json(body);
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
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
    res.status(err.status).json(body);
    return;
  }
  // Unknown — log and return a generic 500 (never leak internals).
  console.error('[error] unhandled:', err);
  const body: ErrorEnvelope = { error: { code: 'INTERNAL', message: 'Internal server error' } };
  res.status(500).json(body);
};

/** Wrap an async handler so thrown errors reach the error handler. */
export function asyncHandler<T extends RequestHandler>(fn: T): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
