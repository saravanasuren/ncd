/** Auth service — login / refresh / logout (docs/13). */
import bcrypt from 'bcryptjs';
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { findByLoginWithSecret, findAuthUserById } from '../users/repo.js';
import { generateRefresh, hashToken, refreshExpiry, signAccess } from './tokens.js';
import { nextSeq } from '../../lib/sequences.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';
import { writeAudit } from '../../lib/audit.js';

export interface Tokens {
  accessToken: string;
  refreshRaw: string;
}

export async function issueSession(
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
  identifier: string,
  password: string,
  meta: { ua?: string; ip?: string }
): Promise<{ user: AuthUser; tokens: Tokens }> {
  const found = await findByLoginWithSecret(db, identifier);
  // Constant-ish work even when user missing (avoid trivial user enumeration).
  const hash = found?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(password, hash);
  if (!found || !ok) throw errors.unauthorized('Invalid credentials');
  if (!found.isActive) throw errors.forbidden('Account is disabled');
  // A self-signed-up account that hasn't been verified within 30 days is blocked.
  if (found.isSelfSignup && !found.verifiedAt) {
    const ageDays = (Date.now() - new Date(found.createdAt).getTime()) / 86_400_000;
    if (ageDays > 30) throw errors.forbidden('Your account has not been verified within 30 days. Please contact an administrator.');
  }
  const tokens = await issueSession(db, found.user, meta);
  return { user: found.user, tokens };
}

// ── Self-service sign-up (Staff / Agent) ─────────────────────────────────
export interface SignupInput {
  type: 'staff' | 'agent';
  mobile: string;
  password: string;
  full_name?: string;   // staff
  employee_id?: string; // staff
  branch_id?: number;   // staff
}

function assertStrongPassword(pw: string): void {
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    throw errors.badRequest('Password must be at least 8 characters and include a letter and a number');
  }
}

/** Create a Staff/Agent login, own-scope by role, unverified pending review. */
export async function signup(db: Db, input: SignupInput): Promise<{ id: number; mobile: string; agent_code?: string }> {
  const digits = input.mobile.replace(/\D/g, '');
  if (digits.length !== 10) throw errors.badRequest('Mobile number must be 10 digits');
  assertStrongPassword(input.password);
  if (input.type === 'staff' && !input.full_name?.trim()) throw errors.badRequest('Name is required');

  return db.withTx(async (tx) => {
    // One login per mobile.
    const dup = await tx.query("SELECT 1 FROM users WHERE regexp_replace(COALESCE(phone,''),'\\D','','g') = $1", [digits]);
    if (dup.rowCount) throw errors.conflict('An account with this mobile number already exists');

    const roleName = input.type === 'staff' ? 'branch_staff' : 'agent';
    const roleId = Number((await tx.query<{ id: string }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]!.id);
    const passwordHash = await bcrypt.hash(input.password, 10);
    const email = `${digits}@signup.local`; // synthetic — login is by mobile

    let agentCode: string | undefined;
    let branchId = input.branch_id ?? null;
    let fullName = input.full_name?.trim() ?? '';
    if (input.type === 'agent') {
      agentCode = `AG-${String(await nextSeq(tx, 'agent')).padStart(4, '0')}`;
      fullName = `Agent ${agentCode}`;
      branchId = Number((await tx.query<{ id: string }>("SELECT id FROM branches WHERE code = 'HO'")).rows[0]?.id ?? null) || null; // HO
    }

    const userId = Number((await tx.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role_id, phone, employee_id, is_self_signup, verified_at, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,NULL,TRUE) RETURNING id`,
      [email, passwordHash, fullName, roleId, digits, input.type === 'staff' ? (input.employee_id ?? null) : null])).rows[0]!.id);

    if (branchId) await tx.query('INSERT INTO user_branches (user_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, branchId]);

    if (input.type === 'agent') {
      await tx.query(
        `INSERT INTO agents (agent_code, full_name, phone, source, commission_status, user_id, is_active)
         VALUES ($1,$2,$3,'self-signup','None',$4,TRUE)`,
        [agentCode, fullName, digits, userId]);
    }

    // Review item in Approvals for Admin/CXO. Maker = the new user (can't self-approve).
    await createApprovalRequest(tx, {
      type: 'user_verification',
      entityType: 'users',
      entityId: userId,
      makerUserId: userId,
      metadata: { user_id: userId, kind: input.type, name: fullName, mobile: digits, employee_id: input.employee_id ?? null, agent_code: agentCode ?? null, branch_id: branchId },
    });
    await writeAudit(tx, { actorId: userId, action: 'user.signup', entityType: 'users', entityId: userId, after: { kind: input.type, mobile: digits } });
    return { id: userId, mobile: digits, agent_code: agentCode };
  });
}

// Approve → mark verified; Reject → deactivate the login.
registerOnFinalApprove('user_verification', async (tx, req) => {
  if (req.entity_id) await tx.query('UPDATE users SET verified_at = now() WHERE id = $1', [Number(req.entity_id)]);
});
registerOnReject('user_verification', async (tx, req) => {
  if (req.entity_id) await tx.query('UPDATE users SET is_active = FALSE WHERE id = $1', [Number(req.entity_id)]);
});

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
