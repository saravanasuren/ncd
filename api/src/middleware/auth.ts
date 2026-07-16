/**
 * Auth + RBAC middleware (docs/03, docs/13).
 *  - attachUser: reads the access cookie, loads the user, sets req.user.
 *  - requireAuth: 401 if not authenticated.
 *  - requirePermission: 403 unless the user holds the permission.
 */
import type { RequestHandler } from 'express';
import type { Permission } from '@new-wealth/shared';
import { getDb } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { verifyAccess } from '../modules/auth/tokens.js';
import { findAuthUserById } from '../modules/users/repo.js';
import '../lib/authUser.js'; // Express.Request augmentation

export const ACCESS_COOKIE = 'nw_access';
export const REFRESH_COOKIE = 'nw_refresh';

export const attachUser: RequestHandler = async (req, _res, next) => {
  try {
    const token = req.cookies?.[ACCESS_COOKIE];
    if (token) {
      const claims = verifyAccess(token);
      if (claims) {
        const user = await findAuthUserById(getDb(), claims.sub);
        if (user) req.user = user;
      }
    }
    next();
  } catch (e) {
    next(e);
  }
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(errors.unauthorized());
  next();
};

export function requirePermission(...perms: Permission[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(errors.unauthorized());
    const held = new Set(req.user.permissions);
    if (perms.some((p) => held.has(p))) return next();
    next(errors.forbidden(`Requires one of: ${perms.join(', ')}`));
  };
}
