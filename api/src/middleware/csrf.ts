/**
 * CSRF guard for cookie-authed mutations (docs/01 §4). Any state-changing
 * method must carry `X-Requested-With: dhanam`. Safe methods pass through.
 */
import type { RequestHandler } from 'express';
import { errors } from '../lib/errors.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (SAFE.has(req.method)) return next();
  if (req.get('X-Requested-With') === 'dhanam') return next();
  next(errors.forbidden('Missing CSRF header'));
};
