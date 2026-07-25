/**
 * repair-partial-redemption-schedule — correct legacy partially-redeemed lines
 * whose disbursement schedule was never scaled to the reduced principal.
 *
 * THE BUG (legacy only). A partial premature redemption reduces
 * `application_lines.outstanding_amount`, and the CURRENT redemption flow also
 * scales the line's unpaid interest rows to match (redemptions/service.ts,
 * shipped 2026-07-22 in #93). Lines redeemed BEFORE that fix kept a schedule
 * that still reflects the full pre-redemption principal:
 *   · future Interest rows compute interest on the old (larger) principal, and
 *   · the maturity Redemption row returns the old (larger) principal.
 * So the customer is set up to be over-paid interest every month, and to be
 * over-returned principal at maturity. (Nothing is wrong with a line redeemed
 * under the current code — this only touches the un-scaled legacy ones.)
 *
 * THE REPAIR — absolute, not relative. For each affected line we regenerate the
 * schedule at the line's CURRENT `outstanding_amount` using the real interest
 * engine (generateSchedule + computeTds — the same code allotment uses), then
 * overwrite each UNPAID, UN-BATCHED Interest / Redemption row with the
 * regenerated gross/tds/net for the same due_date.
 *
 * Writing absolute target values (not a scale factor) is deliberate and is the
 * safety property that matters here:
 *   · IDEMPOTENT — running it twice is a no-op the second time.
 *   · SELF-CORRECTING regardless of current state — a line that was already
 *     half-repaired (interest scaled but maturity not, as one live line is)
 *     lands correct without being double-shrunk, which a blind re-scale would do.
 *
 * What it NEVER touches: Paid rows, rows locked into a batch, and the
 * redemption's own BrokenInterest slice (the interest earned on the exited
 * portion up to the exit — that is correct and separate).
 *
 * DRY-RUN by default (prints a per-line before/after and writes nothing).
 * Pass --commit to apply, inside one transaction.
 *
 * Usage on the box (DATABASE_URL from SSM, like deploy.sh / rematerialize):
 *   unset DATABASE_URL LEGACY_DATABASE_URL; export SSM_PARAMETERS_PATH=/dhanam/newwealth/
 *   node dist/scripts/repair-partial-redemption-schedule.js            # dry-run, all affected
 *   node dist/scripts/repair-partial-redemption-schedule.js APP-2026-000200   # dry-run, one app
 *   node dist/scripts/repair-partial-redemption-schedule.js --commit          # apply
 */
import type { Db } from '../db/types.js';
import { generateSchedule, type PayoutFrequency, type DayCountConvention } from '../lib/interest.js';
import { computeTds } from '../lib/tds.js';
import { round2, toISODate } from '../lib/dates.js';
import { getSettingsMap } from '../modules/settings/service.js';

export interface LineRepair {
  line_id: number;
  application_no: string;
  face: number;
  outstanding: number;
  changes: Array<{ due_date: string; due_type: string; from_gross: number; to_gross: number }>;
}

/**
 * A line needs repair when it is Active, has been partially redeemed
 * (outstanding < face), and at least one UNPAID Interest/Redemption row still
 * reflects a principal larger than the outstanding — i.e. it would over-pay.
 * Returns the exact per-row before/after WITHOUT writing anything.
 */
export async function planLineRepairs(db: Db, appNo?: string): Promise<LineRepair[]> {
  const settings = await getSettingsMap(db);
  const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28);
  const holidays = (await db.query<{ d: string }>('SELECT d FROM holidays')).rows.map((h) => h.d);

  const lines = (await db.query<Record<string, unknown>>(
    `SELECT l.*, a.application_no, a.series_id, a.interest_start_date, a.customer_id
       FROM application_lines l
       JOIN applications a ON a.id = l.application_id
      WHERE l.status = 'Active'
        AND l.outstanding_amount < l.amount
        ${appNo ? 'AND a.application_no = $1' : ''}
      ORDER BY l.id`, appNo ? [appNo] : [])).rows;

  const plans: LineRepair[] = [];
  for (const line of lines) {
    const outstanding = Number(line.outstanding_amount);
    const series = (await db.query<{ deemed_date: string | null }>('SELECT deemed_date FROM series WHERE id = $1', [line.series_id])).rows[0];
    const deemed = toISODate(series?.deemed_date ?? null);
    const interestStartDate = toISODate((line.interest_start_date as string) ?? null) ?? deemed;
    const seriesDeemedDate = deemed ?? interestStartDate;
    if (!interestStartDate || !seriesDeemedDate) continue;

    const tdsRule = line.scheme_id
      ? (await db.query<{ rate_pct: number }>('SELECT tr.* FROM schemes s JOIN tds_rules tr ON tr.id = s.tds_rule_id WHERE s.id = $1', [line.scheme_id])).rows[0] ?? null
      : null;
    const customer = (await db.query<Record<string, unknown>>('SELECT * FROM customers WHERE id = $1', [line.customer_id])).rows[0] ?? {};

    // The schedule the current engine WOULD build for a line of `outstanding`.
    const target = generateSchedule(
      {
        amount: outstanding,
        coupon_rate_pct: Number(line.coupon_rate_pct),
        payout_frequency: line.payout_frequency as PayoutFrequency,
        tenure_months: Number(line.tenure_months),
        day_count_convention: line.day_count_convention as DayCountConvention,
      },
      { interestStartDate, seriesDeemedDate, holidays, payoutDay },
    );
    // Correct gross keyed by (due_date, due_type) — only the types a reduced
    // principal changes. BrokenInterest (the redemption slice) is intentionally
    // absent so it can never be matched and rewritten.
    const targetBy = new Map<string, number>();
    for (const r of target) {
      if (r.due_type === 'Interest' || r.due_type === 'Redemption') targetBy.set(`${r.due_date}|${r.due_type}`, r.gross_amount);
    }

    // The line's own UNPAID, UN-BATCHED rows that a reduced principal would change.
    const unpaid = (await db.query<{ id: string; due_date: string; due_type: string; gross_amount: string }>(
      `SELECT id, due_date::text, due_type, gross_amount FROM disbursement_schedule
        WHERE line_id = $1 AND status = 'Scheduled' AND batch_id IS NULL
          AND due_type IN ('Interest','Redemption')`, [Number(line.id)])).rows;

    const changes: LineRepair['changes'] = [];
    for (const row of unpaid) {
      const key = `${row.due_date.slice(0, 10)}|${row.due_type}`;
      const toGross = targetBy.get(key);
      if (toGross == null) continue; // no engine row for this date — leave it (don't guess)
      const fromGross = Number(row.gross_amount);
      if (round2(fromGross) !== round2(toGross)) {
        changes.push({ due_date: row.due_date.slice(0, 10), due_type: row.due_type, from_gross: fromGross, to_gross: toGross });
      }
    }
    if (changes.length) plans.push({ line_id: Number(line.id), application_no: String(line.application_no), face: Number(line.amount), outstanding, changes });
  }
  return plans;
}

/** Apply the planned repairs. Re-derives TDS per row from the real rule so
 *  gross/tds/net stay consistent (chk_ds_net: net = gross − tds). */
export async function applyLineRepairs(db: Db, appNo?: string): Promise<{ lines: number; rows: number }> {
  return db.withTx(async (tx) => {
    const plans = await planLineRepairs(tx, appNo);
    let rows = 0;
    for (const p of plans) {
      const line = (await tx.query<Record<string, unknown>>('SELECT * FROM application_lines WHERE id = $1', [p.line_id])).rows[0]!;
      const app = (await tx.query<Record<string, unknown>>('SELECT * FROM applications WHERE id = $1', [line.application_id])).rows[0]!;
      const tdsRule = line.scheme_id
        ? (await tx.query<{ rate_pct: number }>('SELECT tr.* FROM schemes s JOIN tds_rules tr ON tr.id = s.tds_rule_id WHERE s.id = $1', [line.scheme_id])).rows[0] ?? null
        : null;
      const customer = (await tx.query<Record<string, unknown>>('SELECT * FROM customers WHERE id = $1', [app.customer_id])).rows[0] ?? {};
      for (const c of p.changes) {
        const gross = round2(c.to_gross);
        const tds = round2(computeTds(tdsRule, customer as never, line as never, { due_type: c.due_type, gross_amount: gross } as never));
        const net = round2(gross - tds);
        await tx.query(
          `UPDATE disbursement_schedule SET gross_amount = $1, tds_amount = $2, net_amount = $3
            WHERE line_id = $4 AND due_date = $5::date AND due_type = $6
              AND status = 'Scheduled' AND batch_id IS NULL`,
          [gross, tds, net, p.line_id, c.due_date, c.due_type]);
        rows++;
      }
    }
    return { lines: plans.length, rows };
  });
}

// ── CLI ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { loadSecretsFromSsm } = await import('../secrets.js');
  const { createDb } = await import('../db/index.js');
  const appNo = process.argv.find((a) => a.startsWith('APP-'));
  const commit = process.argv.includes('--commit');
  await loadSecretsFromSsm();
  const db = createDb();

  const plans = await planLineRepairs(db, appNo);
  if (!plans.length) { console.log('[repair] nothing to do — no un-scaled partial-redemption lines found.'); return; }

  let excess = 0;
  for (const p of plans) {
    console.log(`\n[${p.application_no}] line ${p.line_id} — face ₹${p.face.toLocaleString('en-IN')}, outstanding ₹${p.outstanding.toLocaleString('en-IN')}`);
    for (const c of p.changes) {
      const d = round2(c.from_gross - c.to_gross);
      excess += d;
      console.log(`   ${c.due_date} ${c.due_type.padEnd(10)} ₹${c.from_gross.toLocaleString('en-IN')} → ₹${c.to_gross.toLocaleString('en-IN')}  (−₹${d.toLocaleString('en-IN')})`);
    }
  }
  console.log(`\n[repair] ${plans.length} line(s), ${plans.reduce((n, p) => n + p.changes.length, 0)} row(s). Total over-statement removed: ₹${round2(excess).toLocaleString('en-IN')}`);

  if (!commit) { console.log('[repair] DRY-RUN — nothing written. Re-run with --commit to apply.'); return; }
  const res = await applyLineRepairs(db, appNo);
  console.log(`[repair] committed — ${res.rows} row(s) across ${res.lines} line(s) corrected.`);
}

// Run as CLI only when invoked directly (not when imported by a test).
if (process.argv[1] && process.argv[1].includes('repair-partial-redemption-schedule')) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
