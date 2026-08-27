/**
 * Payout date health — does each investment earn from the day its money arrived?
 *
 * Owner 2026-08-26, after finding two of these by eye on a sheet: "from the
 * system i should not see anything like what just happened." This is that check.
 * It runs against the payout screen and NAMES anything whose accrual start
 * disagrees with its money-received date, BEFORE the interest run goes out.
 *
 * Deliberately a WARNING, never a block (owner's call): a false positive must
 * not be able to hold up a whole month's payout.
 *
 * ─── What it looks for ───────────────────────────────────────────────────────
 * The payout sheet resolves a period start as
 *   COALESCE(<paid watermark>, line.date_money_received, app.interest_start_date)
 * so three shapes make it start on the wrong day:
 *
 *   A  no_line_date            the credit has no date of its own and is leaning
 *                              on interest_start_date. Not wrong by itself, but
 *                              it is the shape that hides B — Mythili D
 *                              APP-2026-001083 was exactly this.
 *   B  interest_start_mismatch interest_start_date disagrees with the money
 *                              date. This one also corrupts the STORED
 *                              schedule, because materialize reads it.
 *   C  line_before_money       a SINGLE-credit investment whose line date
 *                              disagrees with its application's — Senthamil
 *                              Selvi APP-2026-001030 (7 over-paid, 1 under).
 *
 * ─── What it deliberately does NOT flag ──────────────────────────────────────
 * A clubbed investment whose credits carry DIFFERENT dates. That is correct and
 * is the whole point of per-tranche accrual: Nadesan P (5 credits) and
 * S.Priyanka (4) both look wrong to a naive date comparison and are right. Rule
 * C is therefore restricted to single-credit investments.
 *
 * Only lines still in their FIRST period are considered. Once a payout watermark
 * exists it wins the COALESCE outright, so the money date no longer drives the
 * accrual and reporting it would be noise.
 */
import type { Db } from '../../db/types.js';
import { denominatorFor, type DayCountConvention } from '../../lib/interest.js';
import { OUTSTANDING_APPLICATION_STATUSES } from '@new-wealth/shared';

const OUTSTANDING_SQL_LIST = OUTSTANDING_APPLICATION_STATUSES.map((s) => `'${s}'`).join(',');

export type DateIssue = 'no_line_date' | 'interest_start_mismatch' | 'line_before_money';

export interface DateHealthRow {
  application_id: number;
  application_no: string;
  customer_name: string;
  line_id: number;
  tranches: number;
  issue: DateIssue;
  /** What the sheet WILL accrue from. */
  accrual_start: string | null;
  /** What it should be. */
  expected_start: string | null;
  /** + = starts too early (over-pays), − = too late (under-pays). */
  days_wrong: number;
  /** Rupee effect on the next period, rounded. Sign matches days_wrong. */
  rupees: number;
  amount: number;
}

const iso = (d: unknown): string | null => (d == null ? null : String(d).slice(0, 10));
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * Investments whose accrual start looks wrong. Empty array = nothing to say.
 * Never throws for data reasons — a health check that can break the payout
 * screen is worse than no health check.
 */
export async function payoutDateHealth(db: Db): Promise<DateHealthRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT a.id AS application_id, a.application_no, c.full_name AS customer_name,
            l.id AS line_id, l.amount, l.coupon_rate_pct, l.day_count_convention,
            a.date_money_received AS money_date, a.interest_start_date,
            l.date_money_received AS line_date,
            (SELECT count(*)::int FROM application_lines x WHERE x.application_id = a.id) AS tranches
       FROM application_lines l
       JOIN applications a ON a.id = l.application_id
       JOIN customers c ON c.id = a.customer_id
      WHERE l.status = 'Active'
        AND a.status IN (${OUTSTANDING_SQL_LIST})
        -- First period only: past that, the paid watermark wins the COALESCE and
        -- the money date no longer drives anything.
        AND NOT EXISTS (SELECT 1 FROM disbursement_schedule ds
                         WHERE ds.line_id = l.id AND ds.due_type IN ('Interest','BrokenInterest')
                           AND (ds.status = 'Paid' OR (ds.status = 'Scheduled' AND ds.batch_id IS NOT NULL)))
      ORDER BY c.full_name`);

  const out: DateHealthRow[] = [];
  for (const r of rows) {
    const money = iso(r.money_date);
    const start = iso(r.interest_start_date);
    const line = iso(r.line_date);
    const tranches = Number(r.tranches);
    const amount = Number(r.amount);
    const rate = Number(r.coupon_rate_pct);

    // What the sheet will actually use, and what it ought to be.
    const accrual = line ?? start;
    // A clubbed investment's credit dates are REAL and differ on purpose, so the
    // application's single date is not the yardstick for them — only the two
    // application-level faults (A, B) can apply there.
    const expected = tranches === 1 ? money : (line ?? money);

    let issue: DateIssue | null = null;
    if (!line) issue = 'no_line_date';
    else if (money && start && money !== start) issue = 'interest_start_mismatch';
    else if (tranches === 1 && money && line !== money) issue = 'line_before_money';
    if (!issue) continue;

    // For a dateless line the fault only COSTS money when interest_start_date
    // also disagrees; otherwise it is a latent shape, reported at zero rupees.
    const days = accrual && expected ? daysBetween(accrual, expected) : 0;
    const denom = denominatorFor(r.day_count_convention as DayCountConvention, accrual ?? undefined);
    const rupees = Math.round((amount * rate) / 100 * days / denom);

    out.push({
      application_id: Number(r.application_id),
      application_no: String(r.application_no),
      customer_name: String(r.customer_name),
      line_id: Number(r.line_id),
      tranches,
      issue,
      accrual_start: accrual,
      expected_start: expected,
      days_wrong: days,
      rupees,
      amount,
    });
  }
  // Worst money first — that is the order someone fixing them wants.
  return out.sort((a, b) => Math.abs(b.rupees) - Math.abs(a.rupees));
}
