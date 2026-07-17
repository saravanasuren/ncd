/** Leads (CRM) module (docs/04 §2). Per-creator visibility, dedup, convert. */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';
import { createCustomer } from '../customers/service.js';

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

export interface CreateLeadInput {
  full_name: string;
  phone?: string;
  place?: string;
  district?: string;
  category?: string;
  source?: string;
  referred_by_text?: string;
  interested_scheme?: string;
  expected_amount?: number;
  follow_up_date?: string;
  status?: string;
  notes?: string;
}

export async function createLead(db: Db, actor: AuthUser, input: CreateLeadInput) {
  return db.withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO investor_leads (full_name, phone, place, district, category, source, referred_by_text, interested_scheme, expected_amount, follow_up_date, status, notes, created_by_user_id, created_by_agent_id, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [input.full_name, input.phone ?? null, input.place ?? null, input.district ?? null, input.category ?? null,
       input.source ?? null, input.referred_by_text ?? null, input.interested_scheme ?? null, input.expected_amount ?? null,
       input.follow_up_date ?? null, input.status ?? 'New', input.notes ?? null, actor.id, actor.agentId, actor.branchIds[0] ?? null]
    );
    const id = Number(rows[0]!.id);
    await writeAudit(tx, { actorId: actor.id, action: 'lead.create', entityType: 'investor_leads', entityId: id, after: { name: input.full_name } });
    return { id };
  });
}

export async function updateLead(db: Db, actor: AuthUser, id: number, input: Partial<CreateLeadInput>) {
  const fields = ['full_name', 'phone', 'place', 'district', 'category', 'source', 'referred_by_text', 'interested_scheme', 'expected_amount', 'follow_up_date', 'status', 'notes'];
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

/** Convert a lead → a Draft customer (requires confirmed amount + series). */
export async function convertLead(db: Db, actor: AuthUser, leadId: number, confirmedAmount: number, confirmedSeriesId: number) {
  if (!confirmedAmount || !confirmedSeriesId) throw errors.badRequest('Confirmed amount and series are required to convert');
  const lead = (await db.query<{ full_name: string; phone: string | null; district: string | null; referred_by_text: string | null; converted_customer_id: string | null }>(
    'SELECT full_name, phone, district, referred_by_text, converted_customer_id FROM investor_leads WHERE id = $1', [leadId]
  )).rows[0];
  if (!lead) throw errors.notFound('Lead not found');
  if (lead.converted_customer_id) throw errors.conflict('Lead is already converted');

  const created = await createCustomer(db, actor, {
    full_name: lead.full_name,
    phone: lead.phone ?? undefined,
    district: lead.district ?? undefined,
    referred_by_text: lead.referred_by_text ?? undefined,
  });
  await db.query("UPDATE investor_leads SET status = 'Converted', converted_customer_id = $1, updated_at = now() WHERE id = $2", [created.id, leadId]);
  await writeAudit(db, { actorId: actor.id, action: 'lead.convert', entityType: 'investor_leads', entityId: leadId, after: { customerId: created.id, confirmedAmount, confirmedSeriesId } });
  return { customerId: created.id, customer_code: created.customer_code };
}
