/**
 * Read-only export surface `/api/integration/export/v1/*` — the API that
 * replaces the SharePoint CSV dump (docs/NOTWO_INTEGRATION_ARCHITECTURE.md).
 * Mounted behind `requireIntegrationKey` + `integrationLimiter` like the rest
 * of the integration façade.
 *
 * Hard rules (enforced by contract tests):
 *  - GET-ONLY. This router registers no POST/PUT/PATCH/DELETE. Notwo pulls;
 *    it never writes back. There is no NCD→Notwo callback anywhere.
 *  - Figures come from the SAME report functions the dump uses (book.*,
 *    escrowSummary) so the API can never disagree with the app or the dump
 *    during the parallel run.
 *  - Every row carries its stable NCD primary key as `external_*_id` so the
 *    consumer upserts instead of duplicating.
 *  - Fields are an explicit allowlist built by hand below — no `SELECT *`
 *    spread — so a new internal column can never leak. No bank/Aadhaar/OTP/
 *    approval-state fields. PAN travels in FULL (it is the cross-app link key;
 *    owner decision, key-gated server-to-server HTTPS).
 *
 * Stage 1 (this file at first cut): manifest, summary, customers, investments.
 * Stages 2–3 add the remaining book resources and the rent-only locker feed.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { getDb } from '../../db/index.js';
import type { AuthUser } from '../../lib/authUser.js';
import { toISODate } from '../../lib/dates.js';
import * as book from '../reports/book.js';
import { escrowSummary } from '../escrow/service.js';
import { payoutAnchor } from '../dashboard/service.js';
import { getSettingsMap } from '../settings/service.js';

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
const iso = (v: unknown): string | null => {
  if (!v) return null;
  const s = typeof v === 'string' ? v : (v as Date).toISOString();
  return s;
};
/** YYYY-MM-DD from an unknown DB date value (Date or string). */
const dt = (v: unknown): string | null => toISODate(v as string | Date | null | undefined) ?? null;

/** ?cursor=<last id>&limit= — keyset pagination on the source id (default 500,
 * max 2000). Rows must be sorted ascending by their id first. */
function pageParams(req: Request): { cursor: number; limit: number } {
  const cursor = Number(req.query.cursor ?? 0) || 0;
  const raw = Number(req.query.limit ?? 500) || 500;
  return { cursor, limit: Math.max(1, Math.min(2000, raw)) };
}
/** ?updated_since=<ISO> — null when absent or unparseable. */
function sinceParam(req: Request): Date | null {
  const s = req.query.updated_since;
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** Apply keyset window over an id-ascending array; returns the page + next cursor. */
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

/** Cheap freshness probe — the API twin of manifest.json. book_version rolls
 * whenever the book OR a customer record changes, so Notwo pulls only on change. */
exportRouter.get('/manifest', asyncHandler(async (_req, res) => {
  const db = getDb();
  const { rows } = await db.query<{ book_ms: string | null; cust_ms: string | null }>(
    `SELECT (EXTRACT(EPOCH FROM GREATEST(
        COALESCE((SELECT max(updated_at) FROM applications), to_timestamp(0)),
        COALESCE((SELECT max(created_at)  FROM redemptions),  to_timestamp(0)),
        COALESCE((SELECT max(created_at)  FROM payout_batches), to_timestamp(0))
      )) * 1000)::bigint::text AS book_ms,
      (EXTRACT(EPOCH FROM COALESCE((SELECT max(updated_at) FROM customers), to_timestamp(0))) * 1000)::bigint::text AS cust_ms`);
  const bookMs = Number(rows[0]?.book_ms ?? 0);
  const custMs = Number(rows[0]?.cust_ms ?? 0);
  const versionMs = Math.max(bookMs, custMs);
  const counts = await db.query<{ customers: string; investments: string }>(
    `SELECT (SELECT count(*) FROM customers WHERE is_active = TRUE AND archived_at IS NULL) AS customers,
            (SELECT count(*) FROM applications) AS investments`);
  res.json({
    api_version: 1,
    book_version: versionMs > 0 ? new Date(versionMs).toISOString() : null,
    resources: { customers: Number(counts.rows[0]!.customers), investments: Number(counts.rows[0]!.investments) },
    generated_at: new Date().toISOString(),
  });
}));

/** The 14 headline figures — same computations as summary.csv. */
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
  const asOfDate = asOf.slice(0, 10);
  const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28) || 28;
  const accrued = await book.interestAccrued(db, a, {}, payoutAnchor(asOfDate, payoutDay), asOfDate);
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

/** Customers — superset of customers.csv, keyset + updated_since. Full PAN. */
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
      external_customer_id: r.id,
      customer_code: r.customer_code, full_name: r.full_name,
      dob: r.dob ?? null, age: r.age ?? null, phone: r.phone ?? null,
      address: r.address ?? null, tds_status: r.tds_status ?? null,
      total_invested: num(r.total_invested), total_all_time: num(r.total_all_time),
      total_redeemed: num(r.total_redeemed), investment_count: r.applications.length,
      pan: r.pan ?? null,
      kyc_status: m?.kyc_status ?? null,
      is_active: m?.is_active ?? true,
      updated_at: iso(m?.updated_at),
    };
  });
  if (since) out = out.filter((r) => r.updated_at != null && new Date(r.updated_at) > since);
  out.sort((x, y) => x.external_customer_id - y.external_customer_id);
  const { cursor, limit } = pageParams(req);
  const page = keyset(out, (r) => r.external_customer_id, cursor, limit);
  res.json(envelope(page.data, page.next));
}));

/** Investments — superset of investments.csv, keyset + updated_since. */
exportRouter.get('/investments', asyncHandler(async (req, res) => {
  const db = getDb();
  const apps = await book.applicationsFlat(db, SYSTEM_ACTOR) as Array<Record<string, unknown>>;
  // Attribution side-join — same query the extract uses (daily-extract.ts:134).
  const enroller = (await db.query<{ application_no: string; staff_code: string | null; staff_name: string | null; agent_code: string | null; agent_name: string | null; referred_by: string | null }>(
    `SELECT ap.application_no, u.code AS staff_code, u.full_name AS staff_name,
            ag.agent_code, ag.full_name AS agent_name, ap.referred_by_text AS referred_by
       FROM applications ap
       LEFT JOIN users u   ON u.id  = ap.enrolled_by_user_id
       LEFT JOIN agents ag ON ag.id = ap.enrolled_by_agent_id`)).rows;
  const enrollerByNo = new Map(enroller.map((r) => [r.application_no, r]));
  // Stable-id + watermark side-join (applicationsFlat carries no id/updated_at).
  const idMeta = (await db.query<{ id: string; application_no: string; customer_id: string; updated_at: unknown }>(
    `SELECT id, application_no, customer_id, updated_at FROM applications`)).rows;
  const idByNo = new Map(idMeta.map((m) => [String(m.application_no), m]));
  const since = sinceParam(req);
  let out = apps.map((r) => {
    const no = r.application_no as string;
    const e = enrollerByNo.get(no);
    const m = idByNo.get(no);
    return {
      external_application_id: m ? Number(m.id) : 0,
      external_customer_id: m ? Number(m.customer_id) : null,
      application_no: no ?? null, customer_code: (r.customer_code as string) ?? null,
      customer: (r.customer as string) ?? null, series_code: (r.series_code as string) ?? null,
      status: (r.status as string) ?? null, channel: (r.channel as string) ?? null,
      source: (r.source as string) ?? null,
      amount: num(r.total_amount), date_money_received: dt(r.date_money_received),
      allotment_date: dt(r.allotment_date), maturity_date: dt(r.maturity_date),
      redemption_date: dt(r.redemption_date),
      coupon_rate_pct: num(r.coupon_rate_pct), tenure_months: num(r.tenure_months),
      payout_frequency: (r.payout_frequency as string) ?? null,
      staff_code: e?.staff_code ?? null, staff_name: e?.staff_name ?? null,
      agent_code: e?.agent_code ?? null, agent_name: e?.agent_name ?? null,
      referred_by: e?.referred_by ?? null,
      updated_at: iso(m?.updated_at),
    };
  });
  if (since) out = out.filter((r) => r.updated_at != null && new Date(r.updated_at) > since);
  out.sort((x, y) => x.external_application_id - y.external_application_id);
  const { cursor, limit } = pageParams(req);
  const page = keyset(out, (r) => r.external_application_id, cursor, limit);
  res.json(envelope(page.data, page.next));
}));
