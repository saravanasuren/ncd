/**
 * Read-only export surface `/api/integration/export/v1/*` — the API that
 * replaces the SharePoint CSV dump for Notwo
 * (docs/NOTWO_INTEGRATION_ARCHITECTURE.md). Mounted behind
 * `requireIntegrationKey` + `integrationLimiter` like the rest of the façade.
 *
 * Hard rules (enforced by contract tests):
 *  - GET-ONLY. No POST/PUT/PATCH/DELETE. Notwo pulls; it never writes back.
 *  - Figures come from the SAME report functions the dump uses (book.*,
 *    escrowSummary, lockerTenants) so the API can never disagree with the app.
 *  - Every syncable row carries `id` (its stable NCD primary key) so the
 *    consumer upserts, and foreign keys by id (`customer_id`, `series_id`,
 *    `investment_id`, `payee_id`) so it links without name-matching.
 *  - Fields are a hand-built allowlist — no `SELECT *` spread — so no internal
 *    column leaks. No bank/Aadhaar/OTP/approval-state. PAN travels in FULL
 *    (the cross-app link key; key-gated server-to-server HTTPS).
 *
 * Watermarks: only `customers`, `investments` and `locker-cheques` have a real
 * `updated_at` in NCD, so only they honour `?updated_since` (>=). The other
 * book resources are small full-snapshots; `interest` has no stable row id
 * (schedule rows regenerate) so it is a drill-down QUERY endpoint, not synced;
 * `lockers` is a live LockerHub roster. Deletes are handled by Notwo's nightly
 * reconcile (owner decision B) — NCD does not emit tombstones.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { getDb } from '../../db/index.js';
import type { AuthUser } from '../../lib/authUser.js';
import { toISODate } from '../../lib/dates.js';
import * as book from '../reports/book.js';
import * as incentives from '../incentives/service.js';
import { escrowSummary } from '../escrow/service.js';
import { payoutAnchor } from '../dashboard/service.js';
import { getSettingsMap } from '../settings/service.js';
import { lockerTenants } from '../lockers/deposits.js';

/** The export is the WHOLE book — unrestricted scope, same as the daily
 * extract's actor. Read-only; output is key-gated. */
const SYSTEM_ACTOR: AuthUser = {
  id: 0, email: 'system@dhanam.finance', fullName: 'Notwo export',
  role: 'super_admin', permissions: [], branchIds: [], agentId: null, customerId: null,
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Full ISO-8601 UTC timestamp from an unknown DB value. */
const ts = (v: unknown): string | null => {
  if (!v) return null;
  return typeof v === 'string' ? new Date(v).toISOString() : (v as Date).toISOString();
};
/** YYYY-MM-DD date-only from an unknown DB value. */
const dt = (v: unknown): string | null => toISODate(v as string | Date | null | undefined) ?? null;
const idNum = (v: unknown): number | null => (v == null ? null : Number(v));

/** ?cursor=<last id>&limit= — keyset pagination on the numeric id. */
function pageParams(req: Request): { cursor: number; limit: number } {
  const cursor = Number(req.query.cursor ?? 0) || 0;
  const raw = Number(req.query.limit ?? 500) || 500;
  return { cursor, limit: Math.max(1, Math.min(2000, raw)) };
}
/** ?updated_since=<ISO> — null when absent/unparseable. */
function sinceParam(req: Request): Date | null {
  const s = req.query.updated_since;
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** Keyset window over an id-ascending array (>= updated_since applied first). */
function keyset<T>(rowsAscById: T[], idOf: (r: T) => number, cursor: number, limit: number) {
  const after = cursor > 0 ? rowsAscById.filter((r) => idOf(r) > cursor) : rowsAscById;
  const data = after.slice(0, limit);
  const next = after.length > limit ? idOf(data[data.length - 1]!) : null;
  return { data, next };
}
function envelope(data: unknown[], next: number | null, extra: Record<string, unknown> = {}) {
  return { source_system: 'ncd', as_of: new Date().toISOString(), ...extra, data, next_cursor: next };
}

export const exportRouter = Router();

/** Freshness probe — per-resource { max_updated_at, count } + generated_at, so
 * Notwo polls one small endpoint and pulls only what moved. max_updated_at is
 * null for resources with no updated_at column (full-snapshot / live). */
exportRouter.get('/manifest', asyncHandler(async (_req, res) => {
  const db = getDb();
  const r = (await db.query<Record<string, string | null>>(
    `SELECT
       (SELECT max(updated_at) FROM customers)       AS customers_max,
       (SELECT count(*) FROM customers WHERE is_active = TRUE AND archived_at IS NULL) AS customers_n,
       (SELECT max(updated_at) FROM applications)     AS investments_max,
       (SELECT count(*) FROM applications)            AS investments_n,
       (SELECT count(*) FROM series)                  AS series_n,
       (SELECT count(*) FROM redemptions WHERE status IN ('Approved','Paid')) AS redemptions_n,
       (SELECT count(*) FROM users)                   AS staff_n,
       (SELECT count(*) FROM agents)                  AS agents_n,
       (SELECT count(*) FROM incentive_accruals)      AS incentives_n,
       (SELECT count(*) FROM disbursement_schedule)   AS interest_n,
       (SELECT max(updated_at) FROM locker_cheques WHERE leg = 'rent') AS cheques_max,
       (SELECT count(*) FROM locker_cheques WHERE leg = 'rent')        AS cheques_n`)).rows[0]!;
  const R = (max: string | null | undefined, count: string | null | undefined) => ({ max_updated_at: ts(max), count: Number(count ?? 0) });
  res.json({
    api_version: 1,
    generated_at: new Date().toISOString(),
    resources: {
      customers: R(r.customers_max, r.customers_n),
      investments: R(r.investments_max, r.investments_n),
      series: R(null, r.series_n),
      redemptions: R(null, r.redemptions_n),
      staff: R(null, r.staff_n),
      agents: R(null, r.agents_n),
      incentives: R(null, r.incentives_n),
      interest: R(null, r.interest_n),
      'locker-cheques': R(r.cheques_max, r.cheques_n),
    },
  });
}));

/** Headline figures — same computations as summary.csv. One object. */
exportRouter.get('/summary', asyncHandler(async (_req, res) => {
  const db = getDb();
  const a = SYSTEM_ACTOR;
  const [k, esc, customers, apps, series, settings] = await Promise.all([
    book.kpis(db, a) as Promise<Record<string, unknown>>,
    escrowSummary(db),
    book.customerWiseReport(db, a),
    book.applicationsFlat(db, a) as Promise<unknown[]>,
    book.seriesSummary(db, a) as Promise<unknown[]>,
    getSettingsMap(db),
  ]);
  const asOf = new Date().toISOString();
  const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28) || 28;
  const accrued = await book.interestAccrued(db, a, {}, payoutAnchor(asOf.slice(0, 10), payoutDay), asOf.slice(0, 10));
  const runRate = await book.monthlyInterestRunRate(db, a, {});
  res.json({
    source_system: 'ncd', as_of: asOf,
    data: {
      as_of: asOf,
      outstanding_book: num(k.outstanding_book), active_investors: num(k.active_investors),
      interest_paid: num(k.interest_paid), interest_scheduled: num(k.interest_scheduled),
      interest_accrued: num(accrued.total), interest_monthly: num(runRate.gross_monthly),
      interest_daily: Math.round((runRate.annual / 365) * 100) / 100,
      customers: customers.length, investments: apps.length, series: series.length,
      escrow_balance: num(esc.escrow_balance), escrow_not_enrolled: num(esc.not_enrolled_total),
      escrow_as_of: toISODate(esc.as_of) ?? null,
    },
  });
}));

/** Customers — full PAN, keyset + updated_since (>=). */
exportRouter.get('/customers', asyncHandler(async (req, res) => {
  const db = getDb();
  const rows = await book.customerWiseReport(db, SYSTEM_ACTOR);
  const ids = rows.map((r) => r.id);
  const meta = ids.length
    ? (await db.query<{ id: string; kyc_status: string | null; is_active: boolean; updated_at: unknown }>(
        `SELECT id, kyc_status, is_active, updated_at FROM customers WHERE id = ANY($1)`, [ids])).rows
    : [];
  const metaById = new Map(meta.map((m) => [Number(m.id), m]));
  const since = sinceParam(req);
  let out = rows.map((r) => {
    const m = metaById.get(r.id);
    return {
      id: r.id,
      customer_code: r.customer_code, full_name: r.full_name,
      dob: r.dob ?? null, age: r.age ?? null, phone: r.phone ?? null,
      address: r.address ?? null, tds_status: r.tds_status ?? null,
      total_invested: num(r.total_invested), total_all_time: num(r.total_all_time),
      total_redeemed: num(r.total_redeemed), investment_count: r.applications.length,
      pan: r.pan ?? null, kyc_status: m?.kyc_status ?? null, is_active: m?.is_active ?? true,
      updated_at: ts(m?.updated_at),
    };
  });
  if (since) out = out.filter((r) => r.updated_at != null && new Date(r.updated_at) >= since);
  out.sort((x, y) => x.id - y.id);
  const { cursor, limit } = pageParams(req);
  const page = keyset(out, (r) => r.id, cursor, limit);
  res.json(envelope(page.data, page.next));
}));

/** Investments — id + customer_id + series_id, keyset + updated_since (>=). */
exportRouter.get('/investments', asyncHandler(async (req, res) => {
  const db = getDb();
  const apps = await book.applicationsFlat(db, SYSTEM_ACTOR) as Array<Record<string, unknown>>;
  const enroller = (await db.query<{ application_no: string; staff_code: string | null; staff_name: string | null; agent_code: string | null; agent_name: string | null; referred_by: string | null }>(
    `SELECT ap.application_no, u.code AS staff_code, u.full_name AS staff_name,
            ag.agent_code, ag.full_name AS agent_name, ap.referred_by_text AS referred_by
       FROM applications ap
       LEFT JOIN users u   ON u.id  = ap.enrolled_by_user_id
       LEFT JOIN agents ag ON ag.id = ap.enrolled_by_agent_id`)).rows;
  const enrollerByNo = new Map(enroller.map((r) => [r.application_no, r]));
  const idMeta = (await db.query<{ id: string; application_no: string; customer_id: string; series_id: string; updated_at: unknown }>(
    `SELECT id, application_no, customer_id, series_id, updated_at FROM applications`)).rows;
  const idByNo = new Map(idMeta.map((m) => [String(m.application_no), m]));
  const since = sinceParam(req);
  let out = apps.map((r) => {
    const no = r.application_no as string;
    const e = enrollerByNo.get(no);
    const m = idByNo.get(no);
    return {
      id: m ? Number(m.id) : 0, customer_id: m ? Number(m.customer_id) : null, series_id: m ? Number(m.series_id) : null,
      application_no: no ?? null, customer_code: (r.customer_code as string) ?? null,
      customer: (r.customer as string) ?? null, series_code: (r.series_code as string) ?? null,
      status: (r.status as string) ?? null, channel: (r.channel as string) ?? null, source: (r.source as string) ?? null,
      amount: num(r.total_amount), date_money_received: dt(r.date_money_received),
      allotment_date: dt(r.allotment_date), maturity_date: dt(r.maturity_date), redemption_date: dt(r.redemption_date),
      coupon_rate_pct: num(r.coupon_rate_pct), tenure_months: num(r.tenure_months), payout_frequency: (r.payout_frequency as string) ?? null,
      staff_code: e?.staff_code ?? null, staff_name: e?.staff_name ?? null,
      agent_code: e?.agent_code ?? null, agent_name: e?.agent_name ?? null, referred_by: e?.referred_by ?? null,
      updated_at: ts(m?.updated_at),
    };
  });
  if (since) out = out.filter((r) => r.updated_at != null && new Date(r.updated_at) >= since);
  out.sort((x, y) => x.id - y.id);
  const { cursor, limit } = pageParams(req);
  const page = keyset(out, (r) => r.id, cursor, limit);
  res.json(envelope(page.data, page.next));
}));

/** Series — full snapshot. */
exportRouter.get('/series', asyncHandler(async (req, res) => {
  const rows = await book.seriesSummary(getDb(), SYSTEM_ACTOR) as Array<Record<string, unknown>>;
  const out = rows.map((s) => ({
    id: Number(s.series_id), series_code: (s.code as string) ?? null, status: (s.status as string) ?? null,
    investors: num(s.investors), issued: num(s.issued), redeemed: num(s.redeemed), outstanding: num(s.outstanding),
  })).sort((x, y) => x.id - y.id);
  const { cursor, limit } = pageParams(req);
  const page = keyset(out, (r) => r.id, cursor, limit);
  res.json(envelope(page.data, page.next));
}));

/** Redemptions — id + investment_id, full snapshot. */
exportRouter.get('/redemptions', asyncHandler(async (req, res) => {
  const rows = await book.redemptions(getDb(), SYSTEM_ACTOR) as Array<Record<string, unknown>>;
  const out = rows.map((r) => ({
    id: Number(r.external_redemption_id), investment_id: idNum(r.investment_id),
    application_no: (r.application_no as string) ?? null, customer_code: (r.customer_code as string) ?? null,
    redemption_date: dt(r.redemption_date), customer: (r.customer_name as string) ?? null,
    series_code: (r.series_code as string) ?? null, type: (r.type as string) ?? null, net_payment: num(r.net_payment),
  })).sort((x, y) => x.id - y.id);
  const { cursor, limit } = pageParams(req);
  const page = keyset(out, (r) => r.id, cursor, limit);
  res.json(envelope(page.data, page.next));
}));

/** Staff — id, full snapshot. */
exportRouter.get('/staff', asyncHandler(async (req, res) => {
  const rows = (await getDb().query<{ id: string; staff_code: string | null; full_name: string; role: string; is_active: boolean }>(
    `SELECT u.id, u.code AS staff_code, u.full_name, r.name AS role, u.is_active
       FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id`)).rows;
  const out = rows.map((r) => ({
    id: Number(r.id), staff_code: r.staff_code ?? null, full_name: r.full_name ?? null, role: r.role ?? null, active: !!r.is_active,
  }));
  const { cursor, limit } = pageParams(req);
  const page = keyset(out, (r) => r.id, cursor, limit);
  res.json(envelope(page.data, page.next));
}));

/** Agents — id, full snapshot (incl. inactive/deleted — history references them). */
exportRouter.get('/agents', asyncHandler(async (req, res) => {
  const rows = (await getDb().query<{ id: string; agent_code: string | null; full_name: string; commission_rate_pct: unknown; is_active: boolean; deleted_at: unknown }>(
    `SELECT id, agent_code, full_name, commission_rate_pct, is_active, deleted_at FROM agents ORDER BY id`)).rows;
  const out = rows.map((r) => ({
    id: Number(r.id), agent_code: r.agent_code ?? null, full_name: r.full_name ?? null,
    commission_pct: num(r.commission_rate_pct), active: !!(r.is_active && !r.deleted_at),
  }));
  const { cursor, limit } = pageParams(req);
  const page = keyset(out, (r) => r.id, cursor, limit);
  res.json(envelope(page.data, page.next));
}));

/** Incentives — id + investment_id + payee_id, full snapshot. */
exportRouter.get('/incentives', asyncHandler(async (req, res) => {
  const rows = await incentives.accrualsForExtract(getDb());
  const out = rows.map((r) => ({
    id: Number(r.external_accrual_id), investment_id: idNum(r.investment_id),
    application_no: r.application_no ?? null, payee_type: r.payee_type ?? null, payee_id: idNum(r.payee_id),
    payee_code: r.payee_code ?? null, payee_name: r.payee_name ?? null,
    incentive_amount: num(r.incentive_amount), paid: !!r.paid, paid_amount: num(r.paid_amount), accrual_date: dt(r.accrual_date),
  })).sort((x, y) => x.id - y.id);
  const { cursor, limit } = pageParams(req);
  const page = keyset(out, (r) => r.id, cursor, limit);
  res.json(envelope(page.data, page.next));
}));

/** Interest ledger — SERVED for drill-down (no stable row id; schedule rows
 * regenerate). Filter by application/date/status; offset-paginated. */
exportRouter.get('/interest', asyncHandler(async (req, res) => {
  const q = req.query;
  const filters = {
    application_no: typeof q.application_no === 'string' ? q.application_no : undefined,
    from: typeof q.from === 'string' ? q.from : undefined,
    to: typeof q.to === 'string' ? q.to : undefined,
    status: typeof q.status === 'string' ? q.status : undefined,
  };
  const rows = await book.interestLedger(getDb(), SYSTEM_ACTOR, filters) as Array<Record<string, unknown>>;
  const { cursor, limit } = pageParams(req); // cursor = offset (no stable row id)
  const out = rows.slice(cursor, cursor + limit).map((r) => ({
    investment_id: idNum(r.investment_id), application_no: (r.application_no as string) ?? null,
    due_date: dt(r.due_date), customer_code: (r.customer_code as string) ?? null, customer: (r.customer as string) ?? null,
    series_code: (r.series_code as string) ?? null, due_type: (r.due_type as string) ?? null,
    gross_amount: num(r.gross_amount), tds_amount: num(r.tds_amount), net_amount: num(r.net_amount),
    status: (r.status as string) ?? null, paid_at: ts(r.paid_at), utr: (r.utr as string) ?? null,
  }));
  res.json(envelope(out, cursor + limit < rows.length ? cursor + limit : null));
}));

// ── Stage 3 — the rent-only locker feed ───────────────────────────────────

/** Lockers — rent + tenancy + customer link only (NO deposit). Wraps the live
 * lockerTenants() roster; `roster_complete:false` means LockerHub was
 * unreachable and only NCD's own rows are present — Notwo keeps its last good
 * set. `id` is the LockerHub tenancy key (tenant id, or application id before
 * allotment); it and `lockerhub_application_id` are the join keys to
 * locker-cheques. */
exportRouter.get('/lockers', asyncHandler(async (_req, res) => {
  const db = getDb();
  const result = await lockerTenants(db, {}) as { rows: Array<Record<string, unknown>>; roster_complete: boolean; lockerhub_error: string | null };
  const custIds = result.rows.map((r) => Number(r.customer_id)).filter((n) => Number.isFinite(n) && n > 0);
  const pans = custIds.length
    ? (await db.query<{ id: string; pan: string | null }>(`SELECT id, pan FROM customers WHERE id = ANY($1)`, [custIds])).rows
    : [];
  const panById = new Map(pans.map((p) => [Number(p.id), p.pan]));
  const data = result.rows.map((r) => ({
    id: String(r.tenant_id || r.lockerhub_application_id || ''),
    lockerhub_tenant_id: (r.tenant_id as string) || null,
    lockerhub_application_id: (r.lockerhub_application_id as string) || null,
    customer_id: idNum(r.customer_id), customer_code: (r.customer_code as string) ?? null,
    pan: r.customer_id ? (panById.get(Number(r.customer_id)) ?? null) : null,
    locker_no: (r.locker_no as string) ?? null, locker_size: (r.locker_size as string) ?? null,
    branch_id: idNum(r.branch_id), branch_name: (r.branch_name as string) ?? null,
    status: (r.status as string) ?? null, account_status: (r.account_status as string) ?? null,
    allotted_on: dt(r.allotted_on), lease_start: dt(r.lease_start), lease_expires_on: dt(r.lease_expires_on),
    tenant_name: (r.tenant_name as string) ?? null, tenant_phone: (r.tenant_phone as string) ?? null,
    linked_manually: !!r.linked_manually,
    annual_rent: num(r.annual_rent), rent_cheque_pending: !!r.cheque_pending,
  }));
  res.json(envelope(data, null, { roster_complete: result.roster_complete, lockerhub_error: result.lockerhub_error }));
}));

/** Locker rent cheques — NCD's rent-cheque register (leg='rent'). Has its own
 * id + updated_at, so keyset + updated_since (>=). Link to a locker via
 * lockerhub_application_id. */
exportRouter.get('/locker-cheques', asyncHandler(async (req, res) => {
  const db = getDb();
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT lc.id, lc.lockerhub_application_id, lc.customer_id, c.customer_code,
            lc.amount, lc.cheque_no, lc.bank_name, lc.received_on, lc.status, lc.cleared_on,
            lc.lockerhub_settled_at, lc.updated_at
       FROM locker_cheques lc LEFT JOIN customers c ON c.id = lc.customer_id
      WHERE lc.leg = 'rent' ORDER BY lc.id`)).rows;
  const since = sinceParam(req);
  let out = rows.map((r) => ({
    id: Number(r.id), lockerhub_application_id: (r.lockerhub_application_id as string) ?? null,
    customer_id: idNum(r.customer_id), customer_code: (r.customer_code as string) ?? null,
    amount: num(r.amount), cheque_no: (r.cheque_no as string) ?? null, bank_name: (r.bank_name as string) ?? null,
    received_on: dt(r.received_on), status: (r.status as string) ?? null, cleared_on: dt(r.cleared_on),
    lockerhub_settled_at: ts(r.lockerhub_settled_at), updated_at: ts(r.updated_at),
  }));
  if (since) out = out.filter((r) => r.updated_at != null && new Date(r.updated_at) >= since);
  const { cursor, limit } = pageParams(req);
  const page = keyset(out, (r) => r.id, cursor, limit);
  res.json(envelope(page.data, page.next));
}));
