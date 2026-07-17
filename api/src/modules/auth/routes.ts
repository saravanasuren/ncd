/** Auth routes (docs/04 §2). */
import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { config, isProd } from '../../config.js';
import { asyncHandler } from '../../middleware/error.js';
import { ACCESS_COOKIE, REFRESH_COOKIE, requireAuth } from '../../middleware/auth.js';
import { errors } from '../../lib/errors.js';
import * as service from './service.js';
import * as reset from './reset.js';
import { REFRESH_TTL_DAYS } from './tokens.js';

const cookieBase: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  path: '/',
};

function setAuthCookies(res: Response, tokens: service.Tokens): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...cookieBase, maxAge: 15 * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, tokens.refreshRaw, {
    ...cookieBase,
    maxAge: REFRESH_TTL_DAYS * 86400 * 1000,
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, cookieBase);
  res.clearCookie(REFRESH_COOKIE, cookieBase);
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const meta = { ua: req.get('user-agent') ?? undefined, ip: req.ip };
    const { user, tokens } = await service.login(getDb(), email, password, meta);
    setAuthCookies(res, tokens);
    res.json({ user });
  })
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (!raw) throw errors.unauthorized('No session');
    const meta = { ua: req.get('user-agent') ?? undefined, ip: req.ip };
    const { user, tokens } = await service.refresh(getDb(), raw, meta);
    setAuthCookies(res, tokens);
    res.json({ user });
  })
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await service.logout(getDb(), req.cookies?.[REFRESH_COOKIE]);
    clearAuthCookies(res);
    res.json({ ok: true });
  })
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  })
);

authRouter.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    await reset.requestReset(getDb(), email);
    // Always 200 — never reveal whether the email exists.
    res.json({ ok: true });
  })
);

authRouter.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const { token, password } = z.object({ token: z.string().min(1), password: z.string().min(8) }).parse(req.body);
    await reset.resetPassword(getDb(), token, password);
    res.json({ ok: true });
  })
);

authRouter.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8),
    }).parse(req.body);
    await reset.changePassword(getDb(), req.user!.id, currentPassword, newPassword);
    res.json({ ok: true });
  })
);
