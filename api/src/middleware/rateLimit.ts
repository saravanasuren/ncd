/**
 * Rate limits (docs/10 §3). Strict on auth + OTP (credential stuffing), a
 * looser cap on writes. Disabled in tests. Behind nginx, `trust proxy` is set
 * in app.ts so req.ip is the real client.
 */
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

const disabled = config.NODE_ENV === 'test';

function limiter(windowMs: number, max: number, message: string) {
  return rateLimit({
    windowMs,
    max: disabled ? 0 : max, // 0 = unlimited (express-rate-limit treats <=0 as no limit off? use skip instead)
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => disabled,
    message: { error: { code: 'RATE_LIMITED', message } },
  });
}

/** Login / refresh / forgot-password — 20 per 15 min per IP. */
export const authLimiter = limiter(15 * 60 * 1000, 20, 'Too many attempts — try again later');

/** Portal OTP request/verify — 8 per 10 min per IP. */
export const otpLimiter = limiter(10 * 60 * 1000, 8, 'Too many OTP requests — try again later');

/** General write cap — 300 mutations per 5 min per IP (skips safe methods). */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export const writeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => disabled || SAFE.has(req.method),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests — slow down' } },
});

/** Integration endpoints — 600 per minute per IP (LockerHub is chatty). */
export const integrationLimiter = limiter(60 * 1000, 600, 'Integration rate limit exceeded');
