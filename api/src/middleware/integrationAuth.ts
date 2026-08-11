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
  // Accept either the LockerHub key or the Notwo export key, so the two rotate
  // independently. NOTWO key is only honoured when it has actually been issued
  // (a non-empty value) — the empty default never matches an empty header.
  const ok = !!key && (
    safeEqual(key, config.LOCKERHUB_INTEGRATION_KEY) ||
    (config.NOTWO_INTEGRATION_KEY !== '' && safeEqual(key, config.NOTWO_INTEGRATION_KEY))
  );
  if (!ok) return next(errors.unauthorized('Invalid integration key'));
  next();
};
