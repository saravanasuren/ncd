/**
 * Token helpers (docs/13). Access = short-lived JWT in an HttpOnly cookie.
 * Refresh = opaque random token, stored hashed in `sessions`, rotated on use.
 */
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../../config.js';

const ACCESS_TTL = '15m';
export const REFRESH_TTL_DAYS = 30;

export interface AccessClaims {
  sub: number;
  role: string;
}

export function signAccess(claims: AccessClaims): string {
  return jwt.sign(claims, config.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

export function verifyAccess(token: string): AccessClaims | null {
  try {
    const d = jwt.verify(token, config.JWT_ACCESS_SECRET) as jwt.JwtPayload;
    if (typeof d.sub === 'undefined' || typeof d.role !== 'string') return null;
    return { sub: Number(d.sub), role: d.role };
  } catch {
    return null;
  }
}

// ── File-fetch tokens ────────────────────────────────────────────────────
// A short-lived, path-scoped token that lets an external fetcher (WappCloud
// pulling a WhatsApp document header) retrieve ONE document without a session.
// Signed with the app secret → unforgeable; bound to (kind, appId) → can't be
// swapped to another document; 6h covers the fetch + a couple of retries.
const FILE_TTL = '6h';

export function signFileToken(kind: string, appId: number): string {
  return jwt.sign({ scope: 'file', kind, appId }, config.JWT_ACCESS_SECRET, { expiresIn: FILE_TTL });
}

export function verifyFileToken(token: string, kind: string, appId: number): boolean {
  try {
    const d = jwt.verify(token, config.JWT_ACCESS_SECRET) as jwt.JwtPayload;
    return d.scope === 'file' && d.kind === kind && Number(d.appId) === appId;
  } catch {
    return false;
  }
}

export function generateRefresh(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function refreshExpiry(): Date {
  return new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);
}
