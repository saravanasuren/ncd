/** Users & branches admin service (docs/04 §2). */
import bcrypt from 'bcryptjs';
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { isRole, type Role } from '@new-wealth/shared';

export interface UserListRow {
  id: number;
  email: string;
  full_name: string;
  role: string;
  branch_id: number | null;
  branch_ids: number[];
  reports_to_user_id: number | null;
  is_active: boolean;
  code: string | null;
  is_staff: boolean;
}

export async function listUsers(db: Db): Promise<UserListRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT u.id, u.email, u.full_name, r.name AS role, u.branch_id, u.reports_to_user_id, u.is_active, u.code, u.is_staff,
            COALESCE((SELECT array_agg(ub.branch_id) FROM user_branches ub WHERE ub.user_id = u.id), '{}') AS branch_ids
     FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.full_name`
  );
  return rows.map((r) => ({
    id: Number(r.id),
    email: String(r.email),
    full_name: String(r.full_name),
    role: String(r.role),
    branch_id: r.branch_id != null ? Number(r.branch_id) : null,
    branch_ids: (r.branch_ids as (number | string)[]).map(Number),
    reports_to_user_id: r.reports_to_user_id != null ? Number(r.reports_to_user_id) : null,
    is_active: Boolean(r.is_active),
    code: r.code != null ? String(r.code) : null,
    is_staff: Boolean(r.is_staff),
  }));
}

export interface BranchRow {
  id: number;
  code: string;
  name: string;
}

export async function listBranches(db: Db): Promise<BranchRow[]> {
  const { rows } = await db.query<BranchRow>('SELECT id, code, name FROM branches ORDER BY name');
  return rows.map((b) => ({ ...b, id: Number(b.id) }));
}

async function roleId(db: Db, role: Role): Promise<number> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM roles WHERE name = $1', [role]);
  if (!rows[0]) throw errors.badRequest('Unknown role');
  return Number(rows[0].id);
}

export interface CreateUserInput {
  email: string;
  full_name: string;
  role: string;
  password: string;
  branch_id?: number | null;
  reports_to_user_id?: number | null;
  code?: string | null; // unique identity code — what goes in "referred by"
  is_staff?: boolean;   // staff vs agent split on the reports
}

export async function createUser(db: Db, actor: AuthUser, input: CreateUserInput): Promise<{ id: number }> {
  if (!isRole(input.role)) throw errors.badRequest('Unknown role');
  const rid = await roleId(db, input.role);
  const hash = await bcrypt.hash(input.password, 10);
  const code = input.code?.trim().toUpperCase() || null;
  return db.withTx(async (tx) => {
    const existing = await tx.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.email]);
    if (existing.rowCount) throw errors.conflict('Email already in use');
    if (code) {
      const dupe = await tx.query('SELECT 1 FROM users WHERE upper(code) = $1', [code]);
      if (dupe.rowCount) throw errors.conflict('Code already in use');
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role_id, branch_id, reports_to_user_id, code, is_staff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [input.email, hash, input.full_name, rid, input.branch_id ?? null, input.reports_to_user_id ?? null,
       code, input.is_staff ?? true]
    );
    const id = Number(rows[0]!.id);
    await writeAudit(tx, { actorId: actor.id, action: 'user.create', entityType: 'users', entityId: id, after: { email: input.email, role: input.role, code, is_staff: input.is_staff ?? true } });
    return { id };
  });
}

export interface UpdateUserInput {
  full_name?: string;
  email?: string;       // the login address — changing it changes how they sign in
  role?: string;
  branch_id?: number | null;
  reports_to_user_id?: number | null;
  is_active?: boolean;
  password?: string;
  code?: string | null;
  is_staff?: boolean;
}

export interface UserUpdateResult {
  /** Set when marking the user staff auto-folded an agent record into them. */
  agentMerged: { agent_code: string; accruals_moved: number; amount_moved: number } | null;
  /** Set when there WAS an agent record but the auto-merge couldn't run. */
  agentMergeSkipped: string | null;
}

export async function updateUser(db: Db, actor: AuthUser, id: number, input: UpdateUserInput): Promise<UserUpdateResult> {
  await db.withTx(async (tx) => {
    const cur = await tx.query<Record<string, unknown>>('SELECT * FROM users WHERE id = $1', [id]);
    if (!cur.rows[0]) throw errors.notFound('User not found');
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    if (input.full_name !== undefined) { sets.push(`full_name = $${++p}`); params.push(input.full_name); }
    // The login address. Stored lowercase and compared the same way, because
    // login itself is case-insensitive — letting 'Ravi@x' and 'ravi@x' coexist
    // would make a sign-in match two accounts and pick one arbitrarily.
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (!email) throw errors.badRequest('Email is required');
      const dupe = await tx.query('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [email, id]);
      if (dupe.rowCount) throw errors.conflict('Email already in use');
      sets.push(`email = $${++p}`); params.push(email);
    }
    if (input.role !== undefined) {
      if (!isRole(input.role)) throw errors.badRequest('Unknown role');
      sets.push(`role_id = $${++p}`); params.push(await roleId(tx, input.role));
    }
    if (input.branch_id !== undefined) { sets.push(`branch_id = $${++p}`); params.push(input.branch_id); }
    if (input.reports_to_user_id !== undefined) {
      if (input.reports_to_user_id === id) throw errors.badRequest('User cannot report to themselves');
      sets.push(`reports_to_user_id = $${++p}`); params.push(input.reports_to_user_id);
    }
    if (input.is_active !== undefined) { sets.push(`is_active = $${++p}`); params.push(input.is_active); }
    if (input.code !== undefined) {
      const code = input.code?.trim().toUpperCase() || null;
      if (code) {
        const dupe = await tx.query('SELECT 1 FROM users WHERE upper(code) = $1 AND id <> $2', [code, id]);
        if (dupe.rowCount) throw errors.conflict('Code already in use');
      }
      sets.push(`code = $${++p}`); params.push(code);
    }
    if (input.is_staff !== undefined) { sets.push(`is_staff = $${++p}`); params.push(input.is_staff); }
    if (input.password) { sets.push(`password_hash = $${++p}`); params.push(await bcrypt.hash(input.password, 10)); }
    if (!sets.length) return;
    sets.push(`updated_at = now()`);
    params.push(id);
    await tx.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${++p}`, params);
    await writeAudit(tx, { actorId: actor.id, action: 'user.update', entityType: 'users', entityId: id, before: cur.rows[0], after: input });
  });

  // Owner 2026-08-10: marking a user "staff" should make them staff EVERYWHERE,
  // including a person who also holds a separate agent record (the Dhanapal
  // shape). is_staff alone can't move that record's incentive — it's keyed
  // payee_type='agent' — so fold any agent record they own into their now-staff
  // identity automatically. Runs AFTER the update commits (so the merge sees
  // is_staff=true) and OUTSIDE that tx (mergeAgentIntoStaff opens its own).
  let agentMerged: UserUpdateResult['agentMerged'] = null;
  let agentMergeSkipped: string | null = null;
  if (input.is_staff === true) {
    const live = (await db.query<{ id: string }>(
      'SELECT id FROM agents WHERE user_id = $1 AND deleted_at IS NULL', [id])).rows;
    if (live.length) {
      const { mergeAgentIntoStaff } = await import('../agents/service.js');
      try {
        for (const r of live) {
          const res = await mergeAgentIntoStaff(db, actor, Number(r.id), id);
          agentMerged = { agent_code: res.agent_code, accruals_moved: res.accruals_moved, amount_moved: res.amount_moved };
        }
      } catch (e) {
        // Best-effort: the flag is already saved. Surface why the merge could
        // not run (e.g. the same investment already earns on the staff side, or
        // the role is still 'agent') so a human can finish it — never fail the
        // whole edit over it.
        agentMergeSkipped = e instanceof Error ? e.message : 'Could not merge the agent record automatically';
      }
    }
  }
  return { agentMerged, agentMergeSkipped };
}

export async function setUserBranches(db: Db, actor: AuthUser, id: number, branchIds: number[]): Promise<void> {
  await db.withTx(async (tx) => {
    await tx.query('DELETE FROM user_branches WHERE user_id = $1', [id]);
    for (const b of branchIds) {
      await tx.query('INSERT INTO user_branches (user_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, b]);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'user.set-branches', entityType: 'users', entityId: id, after: { branchIds } });
  });
}

export async function deleteUser(db: Db, actor: AuthUser, id: number): Promise<void> {
  const cur = await db.query('SELECT email FROM users WHERE id = $1', [id]);
  if (!cur.rowCount) throw errors.notFound('User not found');
  if (id === actor.id) throw errors.badRequest('You cannot delete your own account');

  // A STAFF user who owns real business records must NOT be hard-deleted — that
  // would orphan those customers/applications and dangle their incentive
  // accruals. Block with a clear message; the account can be disabled instead.
  //
  // An AGENT is different (owner 2026-07-24): deleting the user retires the
  // agent, and the customers they brought in fall back to Direct referrals.
  // So `agents WHERE user_id` is deliberately NOT part of this guard.
  const n = Number((await db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM customers WHERE enrolled_by_user_id = $1)
          + (SELECT count(*) FROM applications WHERE enrolled_by_user_id = $1)
          + (SELECT count(*) FROM investor_leads WHERE created_by_user_id = $1)
          + (SELECT count(*) FROM approval_requests WHERE maker_user_id = $1) AS n`, [id])).rows[0]!.n);
  if (n > 0) {
    throw errors.conflict('This user is linked to customers, applications, leads or approvals — disable the account instead of deleting it.');
  }

  try {
    await db.withTx(async (tx) => {
      // Retire any agent record this user IS, and hand their customers back to
      // Direct. The agent row survives as retired rather than deleted:
      // incentive_accruals.payee_id is a plain BIGINT with no FK, so removing
      // the row would orphan money already accrued/paid and lose the payee's
      // name on it. Retired agents are filtered out of every list instead.
      const agents = (await tx.query<{ id: string; full_name: string; agent_code: string }>(
        'SELECT id, full_name, agent_code FROM agents WHERE user_id = $1 AND deleted_at IS NULL', [id])).rows;
      let movedToDirect = 0;
      for (const ag of agents) {
        const agentId = Number(ag.id);
        const c = await tx.query('UPDATE customers SET enrolled_by_agent_id = NULL, referred_by_text = NULL, updated_at = now() WHERE enrolled_by_agent_id = $1', [agentId]);
        // created_by_agent_id lives on investor_leads, not customers.
        await tx.query('UPDATE investor_leads SET created_by_agent_id = NULL WHERE created_by_agent_id = $1', [agentId]);
        const a = await tx.query('UPDATE applications SET enrolled_by_agent_id = NULL WHERE enrolled_by_agent_id = $1', [agentId]);
        movedToDirect += (c.rowCount ?? 0) + (a.rowCount ?? 0);
        await tx.query(
          "UPDATE agents SET deleted_at = now(), is_active = FALSE, commission_status = 'None', user_id = NULL WHERE id = $1",
          [agentId]);
        await writeAudit(tx, {
          actorId: actor.id, action: 'agent.retire', entityType: 'agents', entityId: agentId,
          after: { via: 'user.delete', agent_code: ag.agent_code, full_name: ag.full_name, rows_moved_to_direct: movedToDirect },
        });
      }
      // Per-user auxiliary rows cascade (sessions, user_branches, …); delete the user.
      await tx.query('DELETE FROM users WHERE id = $1', [id]);
      await writeAudit(tx, {
        actorId: actor.id, action: 'user.delete', entityType: 'users', entityId: id,
        before: cur.rows[0], after: { agents_retired: agents.length, rows_moved_to_direct: movedToDirect },
      });
    });
  } catch (e) {
    // Safety net: any un-enumerated reference → a clear message, never a raw 500.
    if ((e as { code?: string })?.code === '23503') {
      throw errors.conflict('This user is still referenced elsewhere and cannot be deleted. Disable the account instead.');
    }
    throw e;
  }
}
