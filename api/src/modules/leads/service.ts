/** Leads (CRM) module (docs/04 §2). Per-creator visibility, dedup, convert. */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';

const SCOPE_COLS = {
  userCol: 'l.created_by_user_id',
  agentCol: 'l.created_by_agent_id',
  branchCol: 'l.branch_id',
};

export async function listLeads(db: Db, actor: AuthUser) {
  // read-all permission bypasses scope
  if (actor.permissions.includes('leads:read-all')) {
    return (await db.query('SELECT l.* FROM investor_leads l ORDER BY l.created_at DESC LIMIT 2000')).rows;
  }
  const sc = scopeWhere(scopeFor(actor), SCOPE_COLS, 0);
  return (await db.query(`SELECT l.* FROM investor_leads l WHERE ${sc.sql} ORDER BY l.created_at DESC LIMIT 2000`, sc.params)).rows;
}

/**
 * App prospects: dhanamfin/LockerHub profile syncs that no human enrolled and
 * that hold no application — i.e. leads sitting in the `customers` table (the
 * integration keeps them there, referenced by customer_id). This is the exact
 * complement of the Customers-list filter, surfaced on the Leads page so the
 * pool is workable. Enrolling one = opening the customer and adding an
 * application; it then leaves this list and joins Customers.
 */
export async function listAppProspects(db: Db) {
  return (await db.query(
    `SELECT c.id, c.customer_code, c.full_name, c.phone, c.district, c.kyc_status, c.created_at
     FROM customers c
     WHERE c.enrolled_by_user_id IS NULL
       AND c.enrolled_by_agent_id IS NULL
       AND c.is_active = TRUE
       AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.customer_id = c.id)
     ORDER BY c.created_at DESC LIMIT 2000`
  )).rows;
}

export interface CreateLeadInput {
  full_name: string;
  phone?: string;
  place?: string;
  district?: string;
  category?: string;
  source?: string;
  referred_by_text?: string;
  lead_type?: 'ncd' | 'locker';
  interested_scheme?: string;  // NCD leads
  locker_size?: string;        // locker leads (Medium | L | XL)
  expected_amount?: number;
  follow_up_date?: string;
  status?: string;
  notes?: string;
}

export async function createLead(db: Db, actor: AuthUser, input: CreateLeadInput) {
  return db.withTx(async (tx) => {
    // A locker lead carries a size, not a scheme, and vice-versa — keep the
    // irrelevant one null so the two never contradict each other.
    const type = input.lead_type === 'locker' ? 'locker' : 'ncd';
    const scheme = type === 'ncd' ? (input.interested_scheme ?? null) : null;
    const size = type === 'locker' ? (input.locker_size ?? null) : null;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO investor_leads (full_name, phone, place, district, category, source, referred_by_text, lead_type, interested_scheme, locker_size, expected_amount, follow_up_date, status, notes, created_by_user_id, created_by_agent_id, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [input.full_name, input.phone ?? null, input.place ?? null, input.district ?? null, input.category ?? null,
       input.source ?? null, input.referred_by_text ?? null, type, scheme, size, input.expected_amount ?? null,
       input.follow_up_date ?? null, input.status ?? 'New', input.notes ?? null, actor.id, actor.agentId, actor.branchIds[0] ?? null]
    );
    const id = Number(rows[0]!.id);
    await writeAudit(tx, { actorId: actor.id, action: 'lead.create', entityType: 'investor_leads', entityId: id, after: { name: input.full_name, lead_type: type } });
    return { id };
  });
}

export async function updateLead(db: Db, actor: AuthUser, id: number, input: Partial<CreateLeadInput>) {
  const fields = ['full_name', 'phone', 'place', 'district', 'category', 'source', 'referred_by_text', 'lead_type', 'interested_scheme', 'locker_size', 'expected_amount', 'follow_up_date', 'status', 'notes'];
  await db.withTx(async (tx) => {
    const cur = (await tx.query('SELECT * FROM investor_leads WHERE id = $1', [id])).rows[0];
    if (!cur) throw errors.notFound('Lead not found');
    const sets: string[] = []; const params: unknown[] = []; let p = 0;
    for (const f of fields) if ((input as Record<string, unknown>)[f] !== undefined) { sets.push(`${f} = $${++p}`); params.push((input as Record<string, unknown>)[f]); }
    if (!sets.length) return;
    sets.push('updated_at = now()'); params.push(id);
    await tx.query(`UPDATE investor_leads SET ${sets.join(', ')} WHERE id = $${++p}`, params);
    await writeAudit(tx, { actorId: actor.id, action: 'lead.update', entityType: 'investor_leads', entityId: id, before: cur, after: input });
  });
}

export async function listNotes(db: Db, leadId: number) {
  return (await db.query(
    `SELECT n.id, n.note, n.created_at, u.full_name AS author
     FROM lead_notes n LEFT JOIN users u ON u.id = n.created_by_user_id
     WHERE n.lead_id = $1 ORDER BY n.id DESC`, [leadId])).rows;
}

export async function addNote(db: Db, actor: AuthUser, leadId: number, note: string) {
  await db.query('INSERT INTO lead_notes (lead_id, note, created_by_user_id) VALUES ($1,$2,$3)', [leadId, note, actor.id]);
}

/** Duplicate-phone check → surfaces the existing customer + who owns it. */
export async function duplicateCheck(db: Db, phone: string) {
  if (!phone) return { duplicate: false as const };
  const { rows } = await db.query<{ id: string; customer_code: string; full_name: string; enrolled_by_user_id: string | null }>(
    'SELECT id, customer_code, full_name, enrolled_by_user_id FROM customers WHERE phone = $1 LIMIT 1', [phone]
  );
  if (!rows[0]) return { duplicate: false as const };
  return { duplicate: true as const, customer: { id: Number(rows[0].id), customer_code: rows[0].customer_code, full_name: rows[0].full_name, enrolled_by_user_id: rows[0].enrolled_by_user_id ? Number(rows[0].enrolled_by_user_id) : null } };
}

/**
 * Link a lead to the customer that was just created for it through the full
 * customer form (owner 2026-07-23). Conversion no longer creates a bare
 * customer from the lead's few fields and no longer asks for an amount/series —
 * staff open the normal customer wizard (name pre-filled) and enter KYC, demat,
 * bank, everything, then this marks the lead Converted and records which
 * customer it became.
 */
export async function linkLeadToCustomer(db: Db, actor: AuthUser, leadId: number, customerId: number) {
  return db.withTx(async (tx) => {
    const lead = (await tx.query<{ converted_customer_id: string | null }>(
      'SELECT converted_customer_id FROM investor_leads WHERE id = $1 FOR UPDATE', [leadId])).rows[0];
    if (!lead) throw errors.notFound('Lead not found');
    if (lead.converted_customer_id) throw errors.conflict('Lead is already converted');
    const cust = (await tx.query<{ customer_code: string }>('SELECT customer_code FROM customers WHERE id = $1', [customerId])).rows[0];
    if (!cust) throw errors.notFound('Customer not found');

    await tx.query("UPDATE investor_leads SET status = 'Converted', converted_customer_id = $1, updated_at = now() WHERE id = $2", [customerId, leadId]);
    await writeAudit(tx, { actorId: actor.id, action: 'lead.convert', entityType: 'investor_leads', entityId: leadId, after: { customerId } });
    return { customerId, customer_code: cust.customer_code };
  });
}
