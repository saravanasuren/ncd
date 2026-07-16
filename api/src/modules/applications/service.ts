/**
 * Applications module (docs/04 §2). Lifecycle:
 *   create → PendingCollection → (confirm) PendingEsign → (eSign) PendingAllotment
 *   → (batch allot) Active → Redeemed/Matured…
 * State changes go through the shared state machine.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { nextCode } from '../../lib/sequences.js';
import { assertTransition } from '../../lib/statusMachine.js';
import { toISODate } from '../../lib/dates.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';
import { getSettingsMap } from '../settings/service.js';

const SCOPE_COLS = {
  userCol: 'a.enrolled_by_user_id',
  agentCol: 'a.enrolled_by_agent_id',
  branchCol: 'c.branch_id',
};

export interface CreateApplicationInput {
  customer_id: number;
  series_id: number;
  scheme_id: number;
  amount: number;
}

export async function createApplication(db: Db, actor: AuthUser, input: CreateApplicationInput) {
  const settings = await getSettingsMap(db);
  const appFmt = String(settings['numbering.application_format'] ?? 'APP-{yyyy}-{seq:6}');
  return db.withTx(async (tx) => {
    const scheme = (await tx.query<Record<string, unknown>>('SELECT * FROM schemes WHERE id = $1', [input.scheme_id])).rows[0];
    if (!scheme) throw errors.badRequest('Unknown scheme');
    const customer = (await tx.query<{ referred_by_text: string | null }>('SELECT referred_by_text FROM customers WHERE id = $1', [input.customer_id])).rows[0];
    if (!customer) throw errors.badRequest('Unknown customer');

    const priorCount = Number((await tx.query<{ n: string }>('SELECT count(*)::int AS n FROM applications WHERE customer_id = $1', [input.customer_id])).rows[0]!.n);
    const isNew = priorCount === 0;

    const appNo = await nextCode(tx, 'application', appFmt);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, customer_was_new_at_creation, referred_by_text, source, enrolled_by_user_id, enrolled_by_agent_id)
       VALUES ($1,$2,$3,'PendingCollection',$4,$5,$6,'staff',$7,$8) RETURNING id`,
      [appNo, input.customer_id, input.series_id, input.amount, isNew, customer.referred_by_text ?? null, actor.id, actor.agentId]
    );
    const appId = Number(rows[0]!.id);
    await tx.query(
      `INSERT INTO application_lines (application_id, scheme_id, coupon_rate_pct, tenure_months, payout_frequency, day_count_convention, amount, outstanding_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'Active')`,
      [appId, input.scheme_id, scheme.coupon_rate_pct, scheme.tenure_months, scheme.payout_frequency, scheme.day_count_convention, input.amount]
    );
    await writeAudit(tx, { actorId: actor.id, action: 'application.create', entityType: 'applications', entityId: appId, after: { appNo, amount: input.amount, isNew } });
    return { id: appId, application_no: appNo };
  });
}

export async function confirmCollection(db: Db, actor: AuthUser, appId: number, input: { amount_received: number; date_money_received: string; method: string; reference?: string }) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string; series_id: string }>('SELECT status, series_id FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    assertTransition('application', app.status, 'PendingEsign');
    const series = (await tx.query<{ deemed_date: string | null }>('SELECT deemed_date FROM series WHERE id = $1', [app.series_id])).rows[0];
    const deemed = toISODate(series?.deemed_date ?? null);
    // interest_start_date = max(receipt date, series deemed date)
    const isd = deemed && deemed > input.date_money_received ? deemed : input.date_money_received;
    const colNo = await nextCode(tx, 'collection', 'COL-{yyyy}-{seq:6}');
    await tx.query('INSERT INTO collections (collection_no, application_id, amount, method, reference, collection_date, confirmed_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [colNo, appId, input.amount_received, input.method, input.reference ?? null, input.date_money_received, actor.id]);
    await tx.query(
      `UPDATE applications SET status = 'PendingEsign', amount_received = $1, date_money_received = $2, collection_method = $3, collection_reference = $4, interest_start_date = $5, updated_at = now() WHERE id = $6`,
      [input.amount_received, input.date_money_received, input.method, input.reference ?? null, isd, appId]
    );
    await writeAudit(tx, { actorId: actor.id, action: 'application.confirm-collection', entityType: 'applications', entityId: appId, after: { interest_start_date: isd } });
    return { interest_start_date: isd };
  });
}

export async function markESigned(db: Db, actor: AuthUser, appId: number) {
  await db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    assertTransition('application', app.status, 'PendingAllotment');
    await tx.query("UPDATE applications SET status = 'PendingAllotment', updated_at = now() WHERE id = $1", [appId]);
    await writeAudit(tx, { actorId: actor.id, action: 'application.esigned', entityType: 'applications', entityId: appId });
  });
}

export async function listApplications(db: Db, actor: AuthUser, filters: { status?: string; series_id?: number } = {}) {
  const conds: string[] = [];
  const params: unknown[] = [];
  const sc = scopeWhere(scopeFor(actor), SCOPE_COLS, 0);
  conds.push(sc.sql); params.push(...sc.params);
  if (filters.status) { params.push(filters.status); conds.push(`a.status = $${params.length}`); }
  if (filters.series_id) { params.push(filters.series_id); conds.push(`a.series_id = $${params.length}`); }
  const { rows } = await db.query(
    `SELECT a.id, a.application_no, a.status, a.total_amount, a.allotment_date, a.maturity_date,
            c.full_name AS customer_name, c.customer_code, s.code AS series_code
     FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE ${conds.join(' AND ')} ORDER BY a.created_at DESC LIMIT 500`,
    params
  );
  return rows;
}

export async function getApplicationDetail(db: Db, actor: AuthUser, appId: number) {
  const sc = scopeWhere(scopeFor(actor), SCOPE_COLS, 1);
  const app = (await db.query(
    `SELECT a.*, c.full_name AS customer_name, c.customer_code, s.code AS series_code
     FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE a.id = $1 AND ${sc.sql}`, [appId, ...sc.params])).rows[0];
  if (!app) throw errors.notFound('Application not found');
  const lines = (await db.query('SELECT * FROM application_lines WHERE application_id = $1', [appId])).rows;
  const schedule = (await db.query('SELECT id, due_date, due_type, gross_amount, tds_amount, net_amount, status, paid_at FROM disbursement_schedule WHERE application_id = $1 ORDER BY due_date', [appId])).rows;
  return { application: app, lines, schedule };
}
