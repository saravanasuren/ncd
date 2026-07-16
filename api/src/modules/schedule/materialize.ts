/**
 * Materialise the disbursement schedule for an application at allotment
 * (docs/02 §4,§6). Uses the Phase-1 interest engine + TDS, snapshotting the
 * TDS rate and payee bank onto each row. Idempotent per application.
 */
import type { Db } from '../../db/types.js';
import { generateSchedule, type PayoutFrequency, type DayCountConvention } from '../../lib/interest.js';
import { computeTds } from '../../lib/tds.js';
import { round2, toISODate } from '../../lib/dates.js';
import { getSettingsMap } from '../settings/service.js';

export async function materializeForApplication(tx: Db, applicationId: number): Promise<number> {
  const app = (await tx.query<Record<string, unknown>>('SELECT * FROM applications WHERE id = $1', [applicationId])).rows[0];
  if (!app) return 0;

  // Idempotency: skip if already materialised.
  const existing = await tx.query('SELECT 1 FROM disbursement_schedule WHERE application_id = $1 LIMIT 1', [applicationId]);
  if (existing.rowCount) return 0;

  const settings = await getSettingsMap(tx);
  const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28);

  const series = (await tx.query<{ deemed_date: string | null }>('SELECT deemed_date FROM series WHERE id = $1', [app.series_id])).rows[0];
  const deemed = toISODate(series?.deemed_date ?? null);
  const interestStartDate = toISODate((app.interest_start_date as string) ?? null) ?? deemed;
  const seriesDeemedDate = deemed ?? interestStartDate;
  if (!interestStartDate || !seriesDeemedDate) return 0;

  const holidays = (await tx.query<{ d: string }>('SELECT d FROM holidays')).rows.map((h) => h.d);
  const customer = (await tx.query<Record<string, unknown>>('SELECT * FROM customers WHERE id = $1', [app.customer_id])).rows[0] ?? {};

  // Active payee bank account (snapshotted per row).
  const bank = (await tx.query<{ account_number: string; ifsc: string }>(
    'SELECT account_number, ifsc FROM customer_bank_accounts WHERE customer_id = $1 AND is_active = TRUE LIMIT 1',
    [app.customer_id]
  )).rows[0];

  const lines = (await tx.query<Record<string, unknown>>('SELECT * FROM application_lines WHERE application_id = $1', [applicationId])).rows;
  let count = 0;
  for (const line of lines) {
    const tdsRule = line.scheme_id
      ? (await tx.query<{ rate_pct: number }>('SELECT tr.* FROM schemes s JOIN tds_rules tr ON tr.id = s.tds_rule_id WHERE s.id = $1', [line.scheme_id])).rows[0] ?? null
      : null;

    const rows = generateSchedule(
      {
        amount: Number(line.amount),
        coupon_rate_pct: Number(line.coupon_rate_pct),
        payout_frequency: line.payout_frequency as PayoutFrequency,
        tenure_months: Number(line.tenure_months),
        day_count_convention: line.day_count_convention as DayCountConvention,
      },
      { interestStartDate, seriesDeemedDate, holidays, payoutDay }
    );

    // Stamp line maturity (last Redemption row date).
    const redemption = rows.find((r) => r.due_type === 'Redemption');
    if (redemption) {
      await tx.query('UPDATE application_lines SET maturity_date = $1 WHERE id = $2', [redemption.due_date, line.id]);
      await tx.query('UPDATE applications SET maturity_date = $1 WHERE id = $2 AND (maturity_date IS NULL OR maturity_date < $1)', [redemption.due_date, applicationId]);
    }

    for (const r of rows) {
      const tds = round2(computeTds(tdsRule, customer, line as never, r));
      const net = round2(r.gross_amount - tds);
      await tx.query(
        `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status, payee_account, payee_ifsc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Scheduled',$8,$9)`,
        [line.id, applicationId, r.due_date, r.due_type, r.gross_amount, tds, net, bank?.account_number ?? null, bank?.ifsc ?? null]
      );
      count++;
    }
  }
  return count;
}
