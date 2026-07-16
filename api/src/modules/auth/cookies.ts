/** Shared auth-cookie helpers (used by staff login + portal OTP). */
import type { CookieOptions, Response } from 'express';
import { isProd } from '../../config.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../middleware/auth.js';
import { REFRESH_TTL_DAYS } from './tokens.js';
import type { Tokens } from './service.js';

const base: CookieOptions = { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/' };

export function setAuthCookies(res: Response, tokens: Tokens): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: 15 * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, tokens.refreshRaw, { ...base, maxAge: REFRESH_TTL_DAYS * 86400 * 1000 });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, base);
  res.clearCookie(REFRESH_COOKIE, base);
}
