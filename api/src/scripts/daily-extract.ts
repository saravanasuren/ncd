/**
 * daily-extract — the NCD book as flat CSVs, for the consolidated investments
 * dashboard (owner 2026-07-31).
 *
 * NOT a backup. The nightly pg_dump (ops/backup.sh) already covers disaster
 * recovery, but a .sql.gz cannot be read by a dashboard without restoring a
 * whole PostgreSQL database first. This writes the same book as plain CSV that
 * Power BI / Excel / Sheets can open directly.
 *
 * Every figure comes from the app's OWN report functions (modules/reports/book),
 * never a hand-written query. That is deliberate: a dashboard that computes
 * "outstanding" its own way WILL drift from the app, and then nobody can say
 * which number is right. If the book changes, this follows automatically.
 *
 * PRIVACY (owner 2026-07-31): PAN and bank account numbers are MASKED to their
 * last 4 characters. Names, phones and amounts go through in full — the
 * dashboard needs to identify an investor, but a leaked extract must not be
 * enough to impersonate one. Nothing here can be un-masked downstream.
 *
 * Files written (one per table, plus a manifest):
 *   customers.csv     one row per active customer
 *   investments.csv   one row per investment  ← the dashboard's fact table
 *   interest.csv      one row per scheduled/paid interest or redemption row
 *   redemptions.csv   one row per redemption
 *   series.csv        one row per series, with issued/redeemed/outstanding
 *   summary.csv       single row of headline totals
 *   manifest.json     what ran, when, row counts — so a silent half-write shows
 *
 * Usage on the box (DATABASE_URL comes from SSM, mirroring deploy.sh):
 *   unset DATABASE_URL LEGACY_DATABASE_URL
 *   node dist/scripts/daily-extract.js --out /tmp/ncd-extract
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import type { AuthUser } from '../lib/authUser.js';
import * as book from '../modules/reports/book.js';

/**
 * The extract is the WHOLE book, so it runs with unrestricted scope — same as a
 * super_admin. It is read-only and its output goes to a controlled folder; a
 * branch-scoped extract would silently under-report the company total, which is
 * a worse failure than it sounds (nobody notices a number that is merely small).
 */
const SYSTEM_ACTOR: AuthUser = {
  id: 0, email: 'system@dhanam.finance', fullName: 'Daily extract',
  role: 'super_admin', permissions: [], branchIds: [], agentId: null, customerId: null,
};

/** Last 4 only: `ABCDE1234F` → `******234F`, `50200043907022` → `**********7022`.
 *  Short/absent values become '' rather than leaking a whole short string. */
function mask(v: unknown): string {
  const s = String(v ?? '').trim();
  if (s.length <= 4) return s ? '****' : '';
  return '*'.repeat(s.length - 4) + s.slice(-4);
}

/** ISO date (YYYY-MM-DD) or ''. Dashboards parse this; a locale format does not. */
function d(v: unknown): string {
  if (!v) return '';
  const s = typeof v === 'string' ? v : (v as Date).toISOString();
  return s.slice(0, 10);
}

/** A number as a plain decimal string — no ₹, no thousands separators, so the
 *  dashboard reads it as a number rather than text. Blank stays blank. */
function num(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
}

/** RFC-4180 CSV. Quotes every field: a customer name with a comma (there are
 *  several) would otherwise shift every column after it — silently, and only
 *  for those rows, which is the hardest kind of data bug to spot in a chart. */
function csv(headers: string[], rows: Array<Array<string | number>>): string {
  const cell = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n';
}

async function main() {
  await loadSecretsFromSsm();
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx > -1 ? process.argv[outIdx + 1]! : '/tmp/ncd-extract';
  mkdirSync(outDir, { recursive: true });

  const db = createDb();
  const a = SYSTEM_ACTOR;
  const counts: Record<string, number> = {};
  const write = (name: string, headers: string[], rows: Array<Array<string | number>>) => {
    writeFileSync(join(outDir, name), csv(headers, rows), 'utf8');
    counts[name] = rows.length;
    console.log(`  ${name.padEnd(18)} ${rows.length} rows`);
  };

  console.log('[extract] building…');

  // ── customers ──────────────────────────────────────────────────────────
  // customerWiseReport already resolves per-customer totals the way the app's
  // own Customer-wise report does, so the dashboard's "total invested per
  // customer" is the same number the office sees on screen.
  const customers = await book.customerWiseReport(db, a);
  write('customers.csv',
    ['customer_code', 'full_name', 'dob', 'age', 'pan_masked', 'phone', 'address',
     'tds_status', 'total_invested', 'total_all_time', 'total_redeemed', 'investment_count'],
    customers.map((c) => [
      c.customer_code ?? '', c.full_name ?? '', d(c.dob), c.age ?? '',
      mask(c.pan), c.phone ?? '', c.address ?? '', c.tds_status ?? '',
      num(c.total_invested), num(c.total_all_time), num(c.total_redeemed),
      c.applications?.length ?? 0,
    ]));

  // ── investments (the fact table) ───────────────────────────────────────
  const apps = await book.applicationsFlat(db, a) as Array<Record<string, unknown>>;
  write('investments.csv',
    ['application_no', 'customer_code', 'customer', 'series_code', 'status',
     'amount', 'date_money_received', 'allotment_date', 'maturity_date', 'redemption_date',
     'coupon_rate_pct', 'tenure_months', 'payout_frequency'],
    apps.map((r) => [
      r.application_no as string ?? '', r.customer_code as string ?? '', r.customer as string ?? '',
      r.series_code as string ?? '', r.status as string ?? '',
      num(r.total_amount), d(r.date_money_received), d(r.allotment_date),
      d(r.maturity_date), d(r.redemption_date),
      num(r.coupon_rate_pct), num(r.tenure_months), r.payout_frequency as string ?? '',
    ]));

  // ── interest / disbursement ledger ─────────────────────────────────────
  const ledger = await book.interestLedger(db, a) as Array<Record<string, unknown>>;
  write('interest.csv',
    ['due_date', 'application_no', 'customer_code', 'customer', 'series_code',
     'due_type', 'gross_amount', 'tds_amount', 'net_amount', 'status', 'paid_at', 'utr'],
    ledger.map((r) => [
      d(r.due_date), r.application_no as string ?? '', r.customer_code as string ?? '',
      r.customer as string ?? '', r.series_code as string ?? '', r.due_type as string ?? '',
      num(r.gross_amount), num(r.tds_amount), num(r.net_amount),
      r.status as string ?? '', d(r.paid_at), r.utr as string ?? '',
    ]));

  // ── redemptions ────────────────────────────────────────────────────────
  // Exactly the columns book.redemptions() returns (Approved/Paid only). It is
  // tempting to add principal/penalty/broken_interest here, but that would mean
  // a second, hand-written query — and the moment the app changes how a
  // redemption is valued, the dashboard would quietly disagree with it. The
  // per-row money detail is already in interest.csv as the BrokenInterest and
  // Redemption ledger rows, computed by the same code that pays them.
  const reds = await book.redemptions(db, a) as Array<Record<string, unknown>>;
  write('redemptions.csv',
    ['redemption_date', 'customer', 'series_code', 'type', 'net_payment'],
    reds.map((r) => [
      d(r.redemption_date), r.customer_name as string ?? '',
      r.series_code as string ?? '', r.type as string ?? '', num(r.net_payment),
    ]));

  // ── series ─────────────────────────────────────────────────────────────
  const series = await book.seriesSummary(db, a) as Array<Record<string, unknown>>;
  write('series.csv',
    ['series_code', 'status', 'investors', 'issued', 'redeemed', 'outstanding'],
    series.map((s) => [
      s.code as string ?? '', s.status as string ?? '', num(s.investors),
      num(s.issued), num(s.redeemed), num(s.outstanding),
    ]));

  // ── headline totals ────────────────────────────────────────────────────
  // One row, so the dashboard can show company-level figures without having to
  // re-add the fact table (and reach a different answer).
  const k = await book.kpis(db, a) as Record<string, unknown>;
  const asOf = new Date().toISOString();
  write('summary.csv',
    ['as_of', 'outstanding_book', 'active_investors', 'interest_paid', 'interest_scheduled',
     'customers', 'investments', 'series'],
    [[asOf, num(k.outstanding_book), num(k.active_investors), num(k.interest_paid),
      num(k.interest_scheduled), customers.length, apps.length, series.length]]);

  // ── manifest ───────────────────────────────────────────────────────────
  // Row counts are here so a partial or empty extract is OBVIOUS to whoever
  // loads it. A dashboard fed a silently-empty CSV just shows zero, which reads
  // like a bad month rather than a broken pipeline.
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
    source: 'dhanam-ncd', generated_at: asOf, files: counts,
    masked_fields: ['customers.pan_masked'],
    note: 'Figures come from the NCD app\'s own report functions; PAN masked to last 4.',
  }, null, 2) + '\n', 'utf8');

  console.log(`[extract] done → ${outDir}`);
  process.exit(0);
}

main().catch((e) => { console.error('[extract] FAILED:', e); process.exit(1); });
