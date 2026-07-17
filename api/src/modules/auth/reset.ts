/**
 * Self-service password reset + authed change-password (docs/13).
 * Reset tokens are opaque random strings stored sha256-hashed, single-use,
 * 60-min TTL. forgot-password never reveals whether an email exists.
 */
import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'node:crypto';
import type { Db } from '../../db/types.js';
import { config } from '../../config.js';
import { errors } from '../../lib/errors.js';
import { enqueue, drainOnce } from '../notifications/service.js';
import { writeAudit } from '../../lib/audit.js';

const RESET_TTL_MIN = 60;
const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Issue a reset token + email it. Always resolves (no user enumeration). */
export async function requestReset(db: Db, email: string): Promise<void> {
  const { rows } = await db.query<{ id: string; full_name: string }>(
    'SELECT id, full_name FROM users WHERE lower(email) = lower($1) AND is_active = TRUE', [email]);
  const user = rows[0];
  if (!user) return; // silent — don't leak which emails exist

  const raw = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TTL_MIN * 60000).toISOString();
  await db.query(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [user.id, hashToken(raw), expires]);

  const link = `${config.WEB_ORIGIN}/reset-password?token=${raw}`;
  await enqueue(db, {
    channel: 'email',
    template: 'password_reset',
    to: email,
    payload: { name: user.full_name, link, ttlMinutes: RESET_TTL_MIN },
  });
  await drainOnce(db, 5); // best-effort immediate send
}

/** Consume a token + set the new password; revoke all of the user's sessions. */
export async function resetPassword(db: Db, token: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw errors.badRequest('Password must be at least 8 characters');
  await db.withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
      'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1', [hashToken(token)]);
    const row = rows[0];
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      throw errors.badRequest('This reset link is invalid or has expired. Request a new one.');
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await tx.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, row.user_id]);
    await tx.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.id]);
    // Invalidate every existing session — a reset means "lock everyone else out".
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
    await writeAudit(tx, { actorId: Number(row.user_id), action: 'user.password-reset', entityType: 'users', entityId: Number(row.user_id) });
  });
}

/** Authenticated self-service change: verify current password, set new one. */
export async function changePassword(db: Db, userId: number, currentPassword: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw errors.badRequest('Password must be at least 8 characters');
  const { rows } = await db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const current = rows[0]?.password_hash;
  const ok = current ? await bcrypt.compare(currentPassword, current) : false;
  if (!ok) throw errors.badRequest('Current password is incorrect');
  const hash = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, userId]);
  await writeAudit(db, { actorId: userId, action: 'user.password-change', entityType: 'users', entityId: userId });
}
