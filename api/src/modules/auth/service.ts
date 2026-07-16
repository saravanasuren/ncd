/** Auth service — login / refresh / logout (docs/13). */
import bcrypt from 'bcryptjs';
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { findByEmailWithSecret, findAuthUserById } from '../users/repo.js';
import { generateRefresh, hashToken, refreshExpiry, signAccess } from './tokens.js';

export interface Tokens {
  accessToken: string;
  refreshRaw: string;
}

async function issueSession(
  db: Db,
  user: AuthUser,
  meta: { ua?: string; ip?: string }
): Promise<Tokens> {
  const { raw, hash } = generateRefresh();
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5)`,
    [user.id, hash, refreshExpiry().toISOString(), meta.ua ?? null, meta.ip ?? null]
  );
  return { accessToken: signAccess({ sub: user.id, role: user.role }), refreshRaw: raw };
}

export async function login(
  db: Db,
  email: string,
  password: string,
  meta: { ua?: string; ip?: string }
): Promise<{ user: AuthUser; tokens: Tokens }> {
  const found = await findByEmailWithSecret(db, email);
  // Constant-ish work even when user missing (avoid trivial user enumeration).
  const hash = found?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(password, hash);
  if (!found || !ok) throw errors.unauthorized('Invalid email or password');
  if (!found.isActive) throw errors.forbidden('Account is disabled');
  const tokens = await issueSession(db, found.user, meta);
  return { user: found.user, tokens };
}

export async function refresh(
  db: Db,
  refreshRaw: string,
  meta: { ua?: string; ip?: string }
): Promise<{ user: AuthUser; tokens: Tokens }> {
  const hash = hashToken(refreshRaw);
  const { rows } = await db.query<{ id: string; user_id: string; expires_at: string; revoked_at: string | null }>(
    'SELECT id, user_id, expires_at, revoked_at FROM sessions WHERE token_hash = $1',
    [hash]
  );
  const row = rows[0];
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
    throw errors.unauthorized('Session expired');
  }
  const user = await findAuthUserById(db, Number(row.user_id));
  if (!user) throw errors.unauthorized('Session invalid');
  // Rotate: revoke old, issue new.
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [row.id]);
  const tokens = await issueSession(db, user, meta);
  return { user, tokens };
}

export async function logout(db: Db, refreshRaw: string | undefined): Promise<void> {
  if (!refreshRaw) return;
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    hashToken(refreshRaw),
  ]);
}

export async function me(db: Db, userId: number): Promise<AuthUser | null> {
  return findAuthUserById(db, userId);
}
