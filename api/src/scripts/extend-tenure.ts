/**
 * extend-tenure — lengthen the term of live investments and rebuild the unpaid
 * part of their schedule, leaving everything already paid or already batched
 * exactly as it is.
 *
 * Owner 2026-10-31: NCD 29 and NCD BOND are subordinate-debt products and run
 * for 5 years, not 3. Only the TENURE moves — rate, payout frequency, amounts
 * and the money-received date are untouched.
 *
 * SCOPE is deliberately `tenure_months = 36`, not "everything on the series":
 *   · NCD 29's 232 lines and NCD BOND's 3 lines are 36-month and move.
 *   · NCD BOND's nine 12-month lines (Rs 3.31 cr, maturing Aug 2027) do NOT —
 *     the owner decided those keep their one-year term.
 *   · The stray 12%/12-month line on NCD 29 (APP-2026-001198) is excluded by
 *     the same rule.
 *   · NCD Doubling is already 60 months, so it is a no-op there.
 *
 * HOW THE SCHEDULE IS EXTENDED, and why it is safe:
 *
 * materializeForApplication cannot be used — it is idempotent and skips any
 * application that already has rows. The first approach here regenerated the
 * whole line and spliced it in, which was WRONG: 41 lines were materialised by
 * an older engine that emitted a separate stub row for the opening part-month,
 * where today's engine folds it into the first full month. Same money — line
 * 934 stores 71 + 1,104 where the engine now says a single 1,175 — but
 * different row boundaries, so regenerating would have rewritten rows that are
 * already PAID.
 *
 * So nothing existing is regenerated. Only the TAIL moves:
 *
 *   · every existing row is left exactly as it is, except the Redemption row
 *     and the trailing BrokenInterest stub, which move out by the extra term;
 *   · the additional monthly Interest rows between the old maturity and the new
 *     one are appended, taken from the app's own generateSchedule at the new
 *     tenure (verified above to produce identical rows for the months a 36- and
 *     60-month schedule share, so an appended month matches the cadence);
 *   · a line is refused outright if its Redemption or stub row has already been
 *     paid or batched — that is a matured investment, not one to extend.
 *
 * Nothing is hand-computed: amounts, TDS and rounding all come from the same
 * code the live interest run uses.
 *
 * Usage on the box:
 *   unset DATABASE_URL LEGACY_DATABASE_URL
 *   export SSM_PARAMETERS_PATH=/dhanam/newwealth/ SSM_REGION=ap-south-1
 *   node dist/scripts/extend-tenure.js --series 37,38 --from 36 --to 60
 *   node dist/scripts/extend-tenure.js --series 37,38 --from 36 --to 60 --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import { generateSchedule, type PayoutFrequency, type DayCountConvention } from '../lib/interest.js';
import { roundRupee } from '../lib/dates.js';
import { computeTds, DEFAULT_TDS_RULE } from '../lib/tds.js';
import { getSettingsMap } from '../modules/settings/service.js';

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null);
const money = (n: number) => n.toLocaleString('en-IN');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const seriesIds = (arg('series') ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  const fromMonths = Number(arg('from', '36'));
  const toMonths = Number(arg('to', '60'));
  const commit = process.argv.includes('--commit');
  if (!seriesIds.length || !fromMonths || !toMonths) {
    console.error('usage: --series 37,38 --from 36 --to 60 [--commit]');
    process.exit(1);
  }
  if (toMonths <= fromMonths) {
    console.error('Refusing: this only ever lengthens a term. Shortening one would strand paid rows past the new maturity.');
    process.exit(1);
  }

  await loadSecretsFromSsm();
  const db = createDb();

  const settings = await getSettingsMap(db);
  const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28);
  const nextBatchFromDay = Number(settings['interest.next_batch_from_day'] ?? 0) || 0;
  const holidays = (await db.query<{ d: string }>('SELECT d FROM holidays')).rows.map((h) => h.d);

  const lines = (await db.query<Row>(
    `SELECT l.*, a.series_id, a.application_no, a.interest_start_date, a.customer_id,
            a.payout_bank_account_id, c.full_name, s.code AS series_code, s.deemed_date
       FROM application_lines l
       JOIN applications a ON a.id = l.application_id
       JOIN customers c ON c.id = a.customer_id
       JOIN series s ON s.id = a.series_id
      WHERE a.series_id = ANY($1) AND a.archived_at IS NULL AND l.tenure_months = $2
      ORDER BY a.id, l.id`, [seriesIds, fromMonths])).rows;

  console.log(`${lines.length} line(s) at ${fromMonths} months on series ${seriesIds.join(',')} -> ${toMonths} months`);
  if (!lines.length) return;

  let moved = 0, skipped = 0, added = 0, replaced = 0, kept = 0, notYetLive = 0;
  const skips: string[] = [];

  for (const line of lines) {
    const appId = Number(line.application_id);
    const lineId = Number(line.id);
    const deemed = iso(line.deemed_date);
    const interestStart = iso(line.interest_start_date) ?? deemed;
    const seriesDeemed = deemed ?? interestStart;
    const lineStart = iso(line.date_money_received) ?? interestStart;
    // No start date means the money has not landed yet — an application still
    // awaiting approval, with no schedule to extend. Its term still has to
    // change: materializeForApplication reads tenure_months off the line, so
    // setting it now means the schedule is BUILT at 60 months when it goes live.
    if (!lineStart || !seriesDeemed) {
      const rows = (await db.query<{ n: string }>('SELECT count(*) AS n FROM disbursement_schedule WHERE line_id = $1', [lineId])).rows[0];
      if (Number(rows?.n ?? 0) > 0) {
        skips.push(`${line.application_no} line ${lineId}: has ${rows!.n} schedule row(s) but no start date — leaving it alone`);
        skipped++; continue;
      }
      if (commit) {
        await db.query('UPDATE application_lines SET tenure_months = $1 WHERE id = $2', [toMonths, lineId]);
      }
      notYetLive++;
      continue;
    }

    // The schedule this line SHOULD have at the new tenure, from the app's own engine.
    const want = generateSchedule(
      {
        amount: Number(line.amount),
        coupon_rate_pct: Number(line.coupon_rate_pct),
        payout_frequency: line.payout_frequency as PayoutFrequency,
        tenure_months: toMonths,
        day_count_convention: line.day_count_convention as DayCountConvention,
      },
      { interestStartDate: lineStart, seriesDeemedDate: seriesDeemed, holidays, payoutDay, nextBatchFromDay });

    const tdsRule = line.scheme_id
      ? (await db.query<Row>('SELECT tr.* FROM schemes s JOIN tds_rules tr ON tr.id = s.tds_rule_id WHERE s.id = $1', [line.scheme_id])).rows[0] ?? DEFAULT_TDS_RULE
      : DEFAULT_TDS_RULE;
    const customer = (await db.query<Row>('SELECT * FROM customers WHERE id = $1', [line.customer_id])).rows[0] ?? {};

    const priced = want.map((r) => {
      const gross = roundRupee(r.gross_amount);
      const tds = roundRupee(computeTds(tdsRule as never, customer, line as never, { ...r, gross_amount: gross }));
      return { due_date: r.due_date, due_type: r.due_type, gross, tds, net: gross - tds };
    });
    const wantByKey = new Map(priced.map((r) => [`${r.due_date}|${r.due_type}`, r]));

    const have = (await db.query<Row>(
      `SELECT id, due_date, due_type, gross_amount, status, batch_id FROM disbursement_schedule
        WHERE line_id = $1 ORDER BY due_date`, [lineId])).rows;

    // The tail is what moves: the Redemption row (principal) and the trailing
    // BrokenInterest stub that settles the last part-period.
    const tail = have.filter((h) => h.due_type === 'Redemption' || h.due_type === 'BrokenInterest');
    const settledTail = tail.find((h) => h.status === 'Paid' || h.batch_id != null);
    if (settledTail) {
      skips.push(`${line.application_no} line ${lineId}: its ${String(settledTail.due_type)} row is already ${settledTail.status === 'Paid' ? 'PAID' : 'BATCHED'} — this one has matured, not extending it`);
      skipped++;
      continue;
    }
    if (!tail.length) {
      skips.push(`${line.application_no} line ${lineId}: no Redemption row to move`);
      skipped++;
      continue;
    }

    // Everything that stays: every row that is not the tail. Untouched, whatever
    // engine produced it.
    const keepKeys = new Set(have.filter((h) => !(h.due_type === 'Redemption' || h.due_type === 'BrokenInterest'))
      .map((h) => `${iso(h.due_date)}|${String(h.due_type)}`));
    const frozen = have.filter((h) => h.status === 'Paid' || h.batch_id != null);
    const toDelete = tail;                                   // only ever the tail
    const toInsert = priced.filter((r) => !keepKeys.has(`${r.due_date}|${r.due_type}`));
    const redemption = priced.find((r) => r.due_type === 'Redemption');

    if (!commit) {
      if (moved < 3) {
        console.log(`\n  ${line.application_no} (${line.full_name}) ${line.series_code} Rs ${money(Number(line.amount))}`);
        console.log(`    keep ${have.length - toDelete.length} existing rows (${frozen.length} paid/batched) · move ${toDelete.length} tail · append ${toInsert.length}`);
        console.log(`    maturity ${iso(line.maturity_date) ?? '—'} -> ${redemption?.due_date ?? '?'}`);
      }
      moved++; kept += frozen.length; replaced += toDelete.length; added += toInsert.length;
      continue;
    }

    await db.withTx(async (tx) => {
      // Re-check inside the transaction: a batch could have been cut since.
      const still = (await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM disbursement_schedule
          WHERE line_id = $1 AND id = ANY($2) AND (status <> 'Scheduled' OR batch_id IS NOT NULL)`,
        [lineId, toDelete.map((d) => Number(d.id))])).rows[0];
      if (Number(still?.n ?? 0) > 0) throw new Error(`${line.application_no}: rows changed under us — aborting this line`);

      if (toDelete.length) {
        await tx.query('DELETE FROM disbursement_schedule WHERE id = ANY($1)', [toDelete.map((d) => Number(d.id))]);
      }
      const bank = line.payout_bank_account_id
        ? (await tx.query<Row>('SELECT account_number, ifsc FROM customer_bank_accounts WHERE id = $1', [line.payout_bank_account_id])).rows[0]
        : (await tx.query<Row>('SELECT account_number, ifsc FROM customer_bank_accounts WHERE customer_id = $1 AND is_active = TRUE LIMIT 1', [line.customer_id])).rows[0];
      for (const r of toInsert) {
        await tx.query(
          `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status, payee_account, payee_ifsc)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'Scheduled',$8,$9)`,
          [lineId, appId, r.due_date, r.due_type, r.gross, r.tds, r.net, bank?.account_number ?? null, bank?.ifsc ?? null]);
      }
      await tx.query('UPDATE application_lines SET tenure_months = $1, maturity_date = $2 WHERE id = $3',
        [toMonths, redemption?.due_date ?? null, lineId]);
      // Maturity only ever moves FORWARD on the application — a clubbed
      // investment's other tranche must not drag it back.
      if (redemption) {
        await tx.query('UPDATE applications SET maturity_date = $1, updated_at = now() WHERE id = $2 AND (maturity_date IS NULL OR maturity_date < $1)',
          [redemption.due_date, appId]);
      }
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_data, after_data, created_at)
         VALUES ((SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='super_admin' ORDER BY u.id LIMIT 1),
                 'investment.tenure_extended','application_lines',$1,$2,$3,now())`,
        [String(lineId),
         JSON.stringify({ tenure_months: fromMonths, maturity_date: iso(line.maturity_date), schedule_rows_replaced: toDelete.length }),
         JSON.stringify({ tenure_months: toMonths, maturity_date: redemption?.due_date ?? null, schedule_rows_written: toInsert.length,
                          note: 'Owner 2026-10-31: NCD 29 / NCD BOND are 5-year subordinate debt. Tenure only — rate, frequency and amounts unchanged. Paid and batched rows preserved.' })]);
    });
    moved++; kept += frozen.length; replaced += toDelete.length; added += toInsert.length;
  }

  console.log(`\n${commit ? 'EXTENDED' : 'WOULD EXTEND'}: ${moved} line(s)`);
  console.log(`  paid/batched rows kept untouched : ${kept}`);
  console.log(`  tail rows moved out              : ${replaced}`);
  console.log(`  rows written                     : ${added}`);
  if (notYetLive) console.log(`  term set on ${notYetLive} not-yet-live investment(s) — their schedule is built at ${toMonths} months when the money lands`);
  if (skipped) {
    console.log(`\nSKIPPED ${skipped} line(s) — left exactly as they were:`);
    for (const s of skips.slice(0, 20)) console.log(`  · ${s}`);
  }
  if (!commit) console.log('\nDry run. Re-run with --commit to apply.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
