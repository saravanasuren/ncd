/**
 * Agents admin (owner spec 2026-07-18). Agents are the non-staff referrers:
 * standalone people (no login) or users who also source business. Each has a
 * unique agent_code — codes are what goes in "referred by"; the person mapped
 * to the code earns the incentive. Manual creation here complements the
 * LockerHub self-signup path (integration/agents.ts).
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { nextSeq } from '../../lib/sequences.js';
import { createApprovalRequest } from '../approvals/service.js';

export async function listAgents(db: Db) {
  const { rows } = await db.query(
    `SELECT a.id, a.agent_code, a.full_name, a.phone, a.email, a.source,
            a.commission_status, a.commission_rate_pct, a.is_active, a.user_id,
            a.bank_name, a.branch_name, a.account_number, a.ifsc, a.account_holder_name,
            u.full_name AS user_name
     FROM agents a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.deleted_at IS NULL
     ORDER BY a.full_name`);
  return rows;
}

export interface CreateAgentInput {
  full_name: string;
  agent_code?: string;      // optional — generated when blank
  phone?: string;
  email?: string;
  user_id?: number | null;  // set when this agent is also a user (staff who sources)
  bank_name?: string;
  branch_name?: string;
  account_number?: string;
  ifsc?: string;
  /** Who the account is in the name of — a transfer goes out against this, and
   *  it is not always the agent (a family member's or a firm's account). */
  account_holder_name?: string;
}

/**
 * The users row every agent gets (owner 2026-07-24). No email or password is
 * required to BE an agent, so one is synthesised from the agent code and the
 * password is left NULL — that account cannot authenticate until someone sets
 * a real email and password on it. Returns the existing user when the agent's
 * email already belongs to one, so a person is never duplicated.
 */
export async function ensureUserForAgent(
  tx: Db, agent: { agent_code: string; full_name: string; phone?: string | null; email?: string | null; is_active?: boolean },
): Promise<number> {
  const email = (agent.email ?? '').trim().toLowerCase() || `${agent.agent_code.toLowerCase()}@agents.dhanam.local`;
  const found = (await tx.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0];
  if (found) return Number(found.id);
  // is_staff is FALSE here on purpose — the users table defaults it to TRUE,
  // and this agent is a user now (owner 2026-07-24) but is still an agent, not
  // staff (owner 2026-07-25). Leaving it to the default silently misattributes
  // every agent's referred business as STAFF in the Agent-wise/Staff-wise
  // reports and the incentive split.
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO users (email, full_name, phone, role_id, is_active, password_hash, is_staff)
     VALUES ($1,$2,$3,(SELECT id FROM roles WHERE name = 'agent'),$4,NULL,FALSE) RETURNING id`,
    [email, agent.full_name, agent.phone ?? null, agent.is_active ?? true]);
  return Number(rows[0]!.id);
}

export async function createAgent(db: Db, actor: AuthUser, input: CreateAgentInput) {
  return db.withTx(async (tx) => {
    const code = (input.agent_code?.trim().toUpperCase()) || `AG-${String(await nextSeq(tx, 'agent')).padStart(4, '0')}`;
    const dupe = await tx.query('SELECT 1 FROM agents WHERE upper(agent_code) = $1', [code]);
    if (dupe.rowCount) throw errors.conflict('Agent code already in use');
    // Every agent IS a user, so deleting the user retires the agent everywhere.
    const userId = input.user_id ?? await ensureUserForAgent(tx, { ...input, agent_code: code });
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO agents (agent_code, full_name, phone, email, source, commission_status, user_id,
                           bank_name, branch_name, account_number, ifsc, account_holder_name, is_active)
       VALUES ($1,$2,$3,$4,'manual','None',$5,$6,$7,$8,$9,$10,TRUE) RETURNING id`,
      [code, input.full_name, input.phone ?? null, input.email ?? null, userId,
       input.bank_name ?? null, input.branch_name ?? null, input.account_number ?? null,
       input.ifsc ?? null, input.account_holder_name ?? null]);
    const id = Number(rows[0]!.id);
    await writeAudit(tx, { actorId: actor.id, action: 'agent.create', entityType: 'agents', entityId: id, after: { code, name: input.full_name, user_id: userId } });
    return { id, agent_code: code, user_id: userId };
  });
}

export interface UpdateAgentInput {
  full_name?: string;
  agent_code?: string;
  phone?: string | null;
  email?: string | null;
  user_id?: number | null;
  bank_name?: string | null;
  branch_name?: string | null;
  account_number?: string | null;
  ifsc?: string | null;
  account_holder_name?: string | null;
  is_active?: boolean;
}

export async function updateAgent(db: Db, actor: AuthUser, id: number, input: UpdateAgentInput) {
  await db.withTx(async (tx) => {
    const cur = (await tx.query<Record<string, unknown>>('SELECT * FROM agents WHERE id = $1', [id])).rows[0];
    if (!cur) throw errors.notFound('Agent not found');
    const sets: string[] = []; const params: unknown[] = []; let p = 0;
    const fields: Array<[string, unknown]> = [
      ['full_name', input.full_name], ['phone', input.phone], ['email', input.email],
      ['user_id', input.user_id], ['bank_name', input.bank_name], ['branch_name', input.branch_name],
      ['account_number', input.account_number], ['ifsc', input.ifsc],
      ['account_holder_name', input.account_holder_name], ['is_active', input.is_active],
    ];
    for (const [col, val] of fields) {
      if (val !== undefined) { sets.push(`${col} = $${++p}`); params.push(val); }
    }
    if (!sets.length) return;
    params.push(id);
    await tx.query(`UPDATE agents SET ${sets.join(', ')} WHERE id = $${++p}`, params);
    await writeAudit(tx, { actorId: actor.id, action: 'agent.update', entityType: 'agents', entityId: id, before: cur, after: input });
  });
}

/** Staff users a merge can target — the people an agent record can turn out to be. */
export async function staffCandidates(db: Db, q: string) {
  const like = `%${q.trim()}%`;
  const { rows } = await db.query(
    `SELECT u.id, u.code, u.full_name, u.email, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = TRUE AND u.is_staff = TRUE AND r.name NOT IN ('customer','agent')
        AND (u.full_name ILIKE $1 OR u.code ILIKE $1 OR u.email ILIKE $1)
      ORDER BY u.full_name LIMIT 15`, [like]);
  return rows;
}

export interface MergeIntoStaffResult {
  agent_code: string; agent_name: string; user_name: string;
  accruals_moved: number; amount_moved: number; payouts_moved: number;
  applications_repointed: number; customers_repointed: number;
  shadow_user_deactivated: number | null;
}

/**
 * This agent record is really an employee — fold it into their staff user
 * (owner 2026-08-03, "move everything").
 *
 * Marking a user `is_staff` does nothing to their `agents` row: two tables, no
 * link. So the person stays on the Agents list AND their incentive stays on the
 * agent side, which is what actually matters — Agent-wise reporting keeps
 * counting them. Sometimes it is worse: `resolveReferrer` checks agents BEFORE
 * users, so a referred-by that names an employee can land on a stale agent
 * record of the same name instead of on them.
 *
 * Everything moves — accruals paid and unpaid, and the payout ledger rows that
 * settled them. Leaving paid history behind would keep the agent's name in the
 * reports and make the merge look half-done.
 *
 * The agent row is soft-deleted, never removed: `incentive_accruals.payee_id`
 * is a plain BIGINT with no FK, so a hard delete would orphan money records.
 * Retired agents vanish from every list and stop shadowing the staff user in
 * `resolveReferrer`, so referred-by then resolves to the employee by name.
 */
export async function mergeAgentIntoStaff(
  db: Db, actor: AuthUser, agentId: number, targetUserId: number,
): Promise<MergeIntoStaffResult> {
  return db.withTx(async (tx) => {
    const agent = (await tx.query<{ id: string; agent_code: string; full_name: string; user_id: string | null }>(
      'SELECT id, agent_code, full_name, user_id FROM agents WHERE id = $1 AND deleted_at IS NULL', [agentId])).rows[0];
    if (!agent) throw errors.notFound('Agent not found');

    const user = (await tx.query<{ id: string; full_name: string; is_staff: boolean; role: string }>(
      `SELECT u.id, u.full_name, u.is_staff, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [targetUserId])).rows[0];
    if (!user) throw errors.notFound('Staff member not found');
    // The same rule the shortlist applies — the endpoint must not accept a
    // target the picker would never offer. Role matters as well as the flag:
    // an `agent` account carries is_staff=TRUE in some seeded/legacy rows, and
    // merging an agent into an agent moves the money nowhere useful.
    if (user.role === 'customer' || user.role === 'agent' || !user.is_staff) {
      throw errors.badRequest(
        `${user.full_name} is not a staff account (role: ${user.role}) — tick "staff" on their user, or pick a different person.`);
    }

    // Both sides earning on the SAME application would break the
    // (application, payee_type, payee_id) key. Impossible under today's matrix
    // — with a referrer the staff cell pays 0, so only one row is ever written
    // — but the rates are editable, so refuse loudly rather than lose money.
    const clash = (await tx.query<{ application_no: string }>(
      `SELECT a.application_no
         FROM incentive_accruals mine
         JOIN applications a ON a.id = mine.application_id
        WHERE mine.payee_type = 'agent' AND mine.payee_id = $1
          AND EXISTS (SELECT 1 FROM incentive_accruals theirs
                       WHERE theirs.application_id = mine.application_id
                         AND theirs.payee_type = 'staff' AND theirs.payee_id = $2)`,
      [agentId, targetUserId])).rows;
    if (clash.length) {
      throw errors.conflict(
        `${user.full_name} already earns on ${clash.map((c) => c.application_no).join(', ')} as staff. `
        + 'Merging would put two incentives on one investment — sort those out first.');
    }

    const moved = await tx.query(
      "UPDATE incentive_accruals SET payee_type = 'staff', payee_id = $2 WHERE payee_type = 'agent' AND payee_id = $1",
      [agentId, targetUserId]);
    const amount = (await tx.query<{ total: string }>(
      "SELECT coalesce(sum(amount),0)::text AS total FROM incentive_accruals WHERE payee_type = 'staff' AND payee_id = $1", [targetUserId])).rows[0]!.total;
    // The payout ledger keys on the payee too — leave it and the money already
    // handed over still reads as paid to an agent.
    const payouts = await tx.query(
      "UPDATE incentive_payouts SET payee_type = 'staff', payee_id = $2 WHERE payee_type = 'agent' AND payee_id = $1",
      [agentId, targetUserId]);

    // Their enrolments follow them. enrolled_by_user_id is only filled where it
    // is blank — never overwrite a staff member who really did book it.
    const apps = await tx.query(
      'UPDATE applications SET enrolled_by_agent_id = NULL, enrolled_by_user_id = coalesce(enrolled_by_user_id, $2) WHERE enrolled_by_agent_id = $1',
      [agentId, targetUserId]);
    const custs = await tx.query(
      'UPDATE customers SET enrolled_by_agent_id = NULL, enrolled_by_user_id = coalesce(enrolled_by_user_id, $2) WHERE enrolled_by_agent_id = $1',
      [agentId, targetUserId]);

    await tx.query('UPDATE agents SET deleted_at = now(), is_active = FALSE WHERE id = $1', [agentId]);

    // The placeholder login the agent row carried (ag-xxxx@agents.dhanam.local).
    // Deactivated, not deleted — it may own audit history. Skipped when the
    // agent was already linked to this very person.
    let shadow: number | null = null;
    if (agent.user_id && Number(agent.user_id) !== targetUserId) {
      shadow = Number(agent.user_id);
      await tx.query('UPDATE users SET is_active = FALSE WHERE id = $1', [shadow]);
    }

    await writeAudit(tx, {
      actorId: actor.id, action: 'agent.merge-into-staff', entityType: 'agents', entityId: agentId,
      before: { agent_code: agent.agent_code, agent_name: agent.full_name },
      after: {
        into_user_id: targetUserId, into_user_name: user.full_name,
        accruals_moved: moved.rowCount ?? 0, payouts_moved: payouts.rowCount ?? 0,
        applications_repointed: apps.rowCount ?? 0, customers_repointed: custs.rowCount ?? 0,
        shadow_user_deactivated: shadow,
      },
    });

    return {
      agent_code: agent.agent_code, agent_name: agent.full_name, user_name: user.full_name,
      accruals_moved: moved.rowCount ?? 0, amount_moved: Number(amount),
      payouts_moved: payouts.rowCount ?? 0,
      applications_repointed: apps.rowCount ?? 0, customers_repointed: custs.rowCount ?? 0,
      shadow_user_deactivated: shadow,
    };
  });
}

/**
 * Payee search for the "referred by" dropdown: agents + staff users, by code or
 * name. Each row carries the code to store in referred_by and the display name.
 */
export async function searchPayees(db: Db, q: string) {
  const like = `%${q.trim()}%`;
  const agents = (await db.query(
    `SELECT 'agent' AS kind, id, agent_code AS code, full_name FROM agents
     WHERE is_active = TRUE AND deleted_at IS NULL AND (full_name ILIKE $1 OR agent_code ILIKE $1) ORDER BY full_name LIMIT 10`, [like])).rows;
  const staff = (await db.query(
    `SELECT CASE WHEN u.is_staff THEN 'staff' ELSE 'agent' END AS kind, u.id, u.code, u.full_name
       FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = TRUE AND r.name <> 'customer' AND (u.full_name ILIKE $1 OR u.code ILIKE $1)
     ORDER BY u.full_name LIMIT 10`, [like])).rows;
  return [...agents, ...staff];
}

/**
 * Resolve a referred-by string (code or name) to a known payee. Returns null
 * when nothing matches — the caller then treats it as a NEW agent name.
 */
export async function resolveReferrer(db: Db, text: string): Promise<{ kind: 'staff' | 'agent'; id: number; name: string } | null> {
  const t = text.trim();
  if (!t) return null;
  const agent = (await db.query<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM agents
      WHERE deleted_at IS NULL AND (upper(agent_code) = upper($1) OR lower(btrim(full_name)) = lower($1)) LIMIT 1`, [t])).rows[0];
  if (agent) return { kind: 'agent', id: Number(agent.id), name: agent.full_name };
  const user = (await db.query<{ id: string; full_name: string }>(
    `SELECT u.id, u.full_name FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name <> 'customer' AND (upper(u.code) = upper($1) OR lower(btrim(u.full_name)) = lower($1)) LIMIT 1`, [t])).rows[0];
  if (user) return { kind: 'staff', id: Number(user.id), name: user.full_name };
  return null;
}

/**
 * Free-text referred-by that matches nobody → create a PendingApproval agent +
 * an agent_registration approval (owner: "upon entering free text will be
 * created as new agent upon approval"). Idempotent per normalized name; the
 * existing agent_registration final-approve handler (integration/agents.ts)
 * activates it. Returns the agent id.
 */
export async function ensurePendingAgentForName(tx: Db, actor: AuthUser, name: string): Promise<number> {
  const norm = name.trim().replace(/\s+/g, ' ');
  const existing = (await tx.query<{ id: string }>(
    'SELECT id FROM agents WHERE lower(btrim(full_name)) = lower($1) LIMIT 1', [norm])).rows[0];
  if (existing) return Number(existing.id);
  const code = `AG-${String(await nextSeq(tx, 'agent')).padStart(4, '0')}`;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO agents (agent_code, full_name, source, commission_status, is_active)
     VALUES ($1,$2,'manual','PendingApproval',FALSE) RETURNING id`, [code, norm]);
  const id = Number(rows[0]!.id);
  await createApprovalRequest(tx, {
    type: 'agent_registration', entityType: 'agents', entityId: id,
    makerUserId: actor.id, metadata: { agent_code: code, full_name: norm, origin: 'referred_by' },
  });
  await writeAudit(tx, { actorId: actor.id, action: 'agent.create-from-referral', entityType: 'agents', entityId: id, after: { code, name: norm } });
  return id;
}

/** Active agents for staff "add agent" pickers (contract B24). */
export async function activeAgents(db: Db, limit = 100): Promise<{ id: number; agent_code: string; full_name: string }[]> {
  const lim = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 500);
  const { rows } = await db.query<{ id: string; agent_code: string; full_name: string }>(
    'SELECT id, agent_code, full_name FROM agents WHERE is_active = TRUE AND deleted_at IS NULL ORDER BY full_name LIMIT $1', [lim]);
  return rows.map((r) => ({ id: Number(r.id), agent_code: r.agent_code, full_name: r.full_name }));
}

/**
 * Integration path (staff console via LockerHub, contract B24): propose a new
 * agent → PendingApproval agent + an agent_registration approval. No user actor
 * (makerUserId null). Deduped by normalized full_name — a repeat proposal
 * returns the existing agent with created:false.
 */
export async function proposeAgent(
  db: Db, input: { full_name: string; phone?: string | null; email?: string | null; proposed_by?: string | null }
): Promise<{ agent_id: number; agent_code: string; created: boolean }> {
  const norm = input.full_name.trim().replace(/\s+/g, ' ');
  if (!norm) throw errors.badRequest('full_name required');
  return db.withTx(async (tx) => {
    const existing = (await tx.query<{ id: string; agent_code: string }>(
      'SELECT id, agent_code FROM agents WHERE lower(btrim(full_name)) = lower($1) LIMIT 1', [norm])).rows[0];
    if (existing) return { agent_id: Number(existing.id), agent_code: existing.agent_code, created: false };
    const code = `AG-${String(await nextSeq(tx, 'agent')).padStart(4, '0')}`;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO agents (agent_code, full_name, phone, email, source, commission_status, is_active)
       VALUES ($1,$2,$3,$4,'manual','PendingApproval',FALSE) RETURNING id`,
      [code, norm, input.phone ?? null, input.email ?? null]);
    const id = Number(rows[0]!.id);
    await createApprovalRequest(tx, {
      type: 'agent_registration', entityType: 'agents', entityId: id,
      makerUserId: null, metadata: { agent_code: code, full_name: norm, origin: input.proposed_by ?? 'staff_propose' },
    });
    await writeAudit(tx, { actorId: null, action: 'agent.propose', entityType: 'agents', entityId: id, after: { code, name: norm } });
    return { agent_id: id, agent_code: code, created: true };
  });
}

/**
 * System path (no actor): ensure a single agent exists for a referred-by name
 * during accrual, when the name matched no known payee at enrol time. Deduped
 * by normalized full_name so a name can never yield two agents — the guarantee
 * that referrers no longer double up as separate rows. Unlike
 * ensurePendingAgentForName this raises no approval request (accrual is a
 * background step); commission is granted later via the eligibility flow.
 */
export async function ensureReferralAgent(tx: Db, name: string): Promise<number> {
  const norm = name.trim().replace(/\s+/g, ' ');
  const existing = (await tx.query<{ id: string }>(
    'SELECT id FROM agents WHERE lower(btrim(full_name)) = lower($1) LIMIT 1', [norm])).rows[0];
  if (existing) return Number(existing.id);
  const code = `AG-${String(await nextSeq(tx, 'agent')).padStart(4, '0')}`;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO agents (agent_code, full_name, source, commission_status, is_active)
     VALUES ($1,$2,'referral','PendingApproval',TRUE) RETURNING id`, [code, norm]);
  return Number(rows[0]!.id);
}
