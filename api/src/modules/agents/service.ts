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
            a.bank_name, a.account_number, a.ifsc,
            u.full_name AS user_name
     FROM agents a LEFT JOIN users u ON u.id = a.user_id
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
  account_number?: string;
  ifsc?: string;
}

export async function createAgent(db: Db, actor: AuthUser, input: CreateAgentInput) {
  return db.withTx(async (tx) => {
    const code = (input.agent_code?.trim().toUpperCase()) || `AG-${String(await nextSeq(tx, 'agent')).padStart(4, '0')}`;
    const dupe = await tx.query('SELECT 1 FROM agents WHERE upper(agent_code) = $1', [code]);
    if (dupe.rowCount) throw errors.conflict('Agent code already in use');
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO agents (agent_code, full_name, phone, email, source, commission_status, user_id, bank_name, account_number, ifsc, is_active)
       VALUES ($1,$2,$3,$4,'manual','None',$5,$6,$7,$8,TRUE) RETURNING id`,
      [code, input.full_name, input.phone ?? null, input.email ?? null, input.user_id ?? null,
       input.bank_name ?? null, input.account_number ?? null, input.ifsc ?? null]);
    const id = Number(rows[0]!.id);
    await writeAudit(tx, { actorId: actor.id, action: 'agent.create', entityType: 'agents', entityId: id, after: { code, name: input.full_name } });
    return { id, agent_code: code };
  });
}

export interface UpdateAgentInput {
  full_name?: string;
  agent_code?: string;
  phone?: string | null;
  email?: string | null;
  user_id?: number | null;
  bank_name?: string | null;
  account_number?: string | null;
  ifsc?: string | null;
  is_active?: boolean;
}

export async function updateAgent(db: Db, actor: AuthUser, id: number, input: UpdateAgentInput) {
  await db.withTx(async (tx) => {
    const cur = (await tx.query<Record<string, unknown>>('SELECT * FROM agents WHERE id = $1', [id])).rows[0];
    if (!cur) throw errors.notFound('Agent not found');
    const sets: string[] = []; const params: unknown[] = []; let p = 0;
    const fields: Array<[string, unknown]> = [
      ['full_name', input.full_name], ['phone', input.phone], ['email', input.email],
      ['user_id', input.user_id], ['bank_name', input.bank_name],
      ['account_number', input.account_number], ['ifsc', input.ifsc], ['is_active', input.is_active],
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

/**
 * Payee search for the "referred by" dropdown: agents + staff users, by code or
 * name. Each row carries the code to store in referred_by and the display name.
 */
export async function searchPayees(db: Db, q: string) {
  const like = `%${q.trim()}%`;
  const agents = (await db.query(
    `SELECT 'agent' AS kind, id, agent_code AS code, full_name FROM agents
     WHERE is_active = TRUE AND (full_name ILIKE $1 OR agent_code ILIKE $1) ORDER BY full_name LIMIT 10`, [like])).rows;
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
    `SELECT id, full_name FROM agents WHERE upper(agent_code) = upper($1) OR lower(btrim(full_name)) = lower($1) LIMIT 1`, [t])).rows[0];
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
    'SELECT id, agent_code, full_name FROM agents WHERE is_active = TRUE ORDER BY full_name LIMIT $1', [lim]);
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
