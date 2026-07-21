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
import { verifyAccess, verifyFileToken } from '../modules/auth/tokens.js';
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

/**
 * Document routes an external service must fetch (e.g. WappCloud pulling a
 * WhatsApp document header). A valid `?vt=` file token scoped to (kind, :applicationId)
 * authorises in lieu of a session; otherwise fall back to the normal permission
 * check. On token success sets req.fileToken so the handler can skip its
 * session-based visibility check (the token already scopes to that one document).
 */
export function fileTokenOr(kind: string, ...perms: Permission[]): RequestHandler {
  return (req, res, next) => {
    const vt = typeof req.query.vt === 'string' ? req.query.vt : null;
    const appId = Number(req.params.applicationId);
    if (vt && Number.isFinite(appId) && verifyFileToken(vt, kind, appId)) {
      req.fileToken = true;
      return next();
    }
    return requirePermission(...perms)(req, res, next);
  };
}
