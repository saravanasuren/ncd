/** Integration-key auth for /api/integration/* (docs/08 §1). LockerHub /
 * DhanamFin send X-Integration-Key; no cookie/CSRF. */
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { errors } from '../lib/errors.js';

export const requireIntegrationKey: RequestHandler = (req, _res, next) => {
  const key = req.get('X-Integration-Key');
  if (!key || key !== config.LOCKERHUB_INTEGRATION_KEY) {
    return next(errors.unauthorized('Invalid integration key'));
  }
  next();
};
