/**
 * Auth + RBAC middleware (docs/03, docs/13).
 *  - attachUser: reads the access cookie, loads the user, sets req.user.
 *  - requireAuth: 401 if not authenticated.
 *  - requirePermission: 403 unless the user holds the permission.
 *  - requireApprovedAccount: 403 for a self-signup no admin has approved.
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

/**
 * On top of a permission: the account must be one an admin approved.
 *
 * For anything that SPENDS or leaves the building — a paid bank verification,
 * a message to a customer. A self-signed-up account cannot get a session at all
 * now (auth/service.ts), so this is the second lock on the same door: it also
 * covers the ~15 minutes an access token stays valid after an approval is
 * withdrawn, and any future way an unapproved login might arrive.
 *
 * On 2026-10-08 three penny-drop calls — a paid Decentro check — were made by an
 * account nobody had approved, minutes after it signed itself up.
 */
export const requireApprovedAccount: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) return next(errors.unauthorized());
    const r = (await getDb().query<{ is_self_signup: boolean; verified_at: string | null }>(
      'SELECT is_self_signup, verified_at FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (r?.is_self_signup && !r.verified_at) {
      return next(errors.forbidden('Your account is waiting for an administrator to approve it.'));
    }
    next();
  } catch (e) {
    next(e);
  }
};

/**
 * Someone holding a TEMPORARY password may do exactly one thing: set a real one.
 *
 * Eleven NCD logins used a password that leaked through odpulse on 2026-10-08
 * (its /api/users returned every account with its plaintext password, and
 * 23.153.36.167 took that three times). Each was given a fresh temporary
 * password. Without this, "please change your password" is a polite request;
 * with it, the temporary password cannot be used for anything else — including
 * by anyone else who may hold it.
 *
 * The allow-list is what a person needs in order to comply, and nothing more:
 * see who they are, change the password, refresh, sign out. Everything else is
 * a 403 carrying PASSWORD_CHANGE_REQUIRED, which the screen acts on.
 */
const ALLOWED_WHILE_LOCKED = ['/auth/me', '/auth/change-password', '/auth/logout', '/auth/refresh', '/auth/login'];
export const blockUntilPasswordChanged: RequestHandler = (req, _res, next) => {
  if (!req.user?.mustChangePassword) return next();
  if (ALLOWED_WHILE_LOCKED.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
  next(errors.forbidden('PASSWORD_CHANGE_REQUIRED: set a new password before continuing.'));
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
