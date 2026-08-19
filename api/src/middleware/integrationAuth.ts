/** Integration-key auth for /api/integration/* (docs/08 §1). LockerHub /
 * DhanamFin send X-Integration-Key; no cookie/CSRF. */
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { errors } from '../lib/errors.js';

/** Constant-time string compare (avoids a timing oracle on the key). Length
 * mismatch returns false without leaking via early-exit on content. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const requireIntegrationKey: RequestHandler = (req, _res, next) => {
  const key = req.get('X-Integration-Key');
  if (!key || !safeEqual(key, config.LOCKERHUB_INTEGRATION_KEY)) {
    return next(errors.unauthorized('Invalid integration key'));
  }
  next();
};
