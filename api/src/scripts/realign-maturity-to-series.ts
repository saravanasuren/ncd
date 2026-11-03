/**
 * realign-maturity-to-series — move each live investment's maturity onto its
 * SERIES close date + tenure, rebuilding only the unpaid tail of its schedule.
 *
 * Owner 2026-11-03: "the series close date is the allotment date. the redemption
 * date / maturity date should be calculated from series close date + tenure."
 *
 * Nothing here teaches the engine anything new. lib/interest.ts has always said
 *
 *     maturityDate = addMonths(seriesDeemedDate, tenure)
 *
 * and materialize.ts has always fallen back to the money-received date when the
 * series has no deemed date. These series had none, so every investment matured
 * on its own money date. Migration 108 sets series.deemed_date = close_date,
 * which fixes everything enrolled FROM NOW ON by itself. This script is only for
 * the schedules already built — it cannot be done in SQL, because the amounts,
 * TDS and rounding must come from the same code the live interest run uses.
 *
 * INTEREST IS NOT MOVED. generateSchedule is still handed each line's own
 * date_money_received as interestStartDate; only the maturity anchor changes.
 * An early payer therefore earns slightly MORE than the nominal term, and not
 * one of the already-settled rows has to be recomputed or recovered.
 *
 * SAFETY, the same rules that made extend-tenure safe:
 *   · existing rows are never regenerated — several of these lines were built by
 *     an older engine that split the opening part-month differently, and
 *     rewriting those would touch rows that are already PAID;
 *   · only the TAIL moves: the Redemption row and the trailing BrokenInterest
 *     stub, plus whatever extra months the later maturity implies;
 *   · a line whose tail is already paid or batched is REFUSED — that investment
 *     has matured, and is not one to re-date;
 *   · maturity is only ever moved FORWARD. A line whose maturity would move
 *     earlier is refused outright rather than stranding paid rows past it.
 *
 * Usage on the box:
 *   unset DATABASE_URL LEGACY_DATABASE_URL
 *   export SSM_PARAMETERS_PATH=/dhanam/newwealth/ SSM_REGION=ap-south-1
 *   node dist/scripts/realign-maturity-to-series.js --series-like SD%
 *   node dist/scripts/realign-maturity-to-series.js --series-like SD% --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
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
  const seriesLike = arg('series-like');
  const commit = process.argv.includes('--commit');
  if (!seriesLike) {
    console.error('usage: --series-like SD% [--commit]');
    process.exit(1);
  }

  await loadSecretsFromSsm();
  const db = createDb();

  const settings = await getSettingsMap(db);
  const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28);
  const nextBatchFromDay = Number(settings['interest.next_batch_from_day'] ?? 0) || 0;
  const holidays = (await db.query<{ d: string }>('SELECT d FROM holidays')).rows.map((h) => h.d);

  const lines = (await db.query<Row>(
    `SELECT l.*, a.series_id, a.application_no, a.interest_start_date, a.customer_id, a.status AS app_status,
            a.payout_bank_account_id, c.full_name, s.code AS series_code, s.deemed_date
       FROM application_lines l
       JOIN applications a ON a.id = l.application_id
       JOIN customers c ON c.id = a.customer_id
       JOIN series s ON s.id = a.series_id
      WHERE s.code LIKE $1 AND a.archived_at IS NULL
        AND a.status IN ('Active','Matured','Redeemed','RolledOver','PendingApproval')
      ORDER BY a.id, l.id`, [seriesLike])).rows;

  console.log(`${lines.length} line(s) on series like '${seriesLike}'`);
  if (!lines.length) return;

  let moved = 0, skipped = 0, added = 0, replaced = 0, kept = 0, alreadyRight = 0, notYetLive = 0;
  const skips: string[] = [];

  for (const line of lines) {
    const appId = Number(line.application_id);
    const lineId = Number(line.id);
    const deemed = iso(line.deemed_date);
    if (!deemed) {
      skips.push(`${line.application_no}: its series has no deemed date — run migration 108 first`);
      skipped++; continue;
    }
    const lineStart = iso(line.date_money_received) ?? iso(line.interest_start_date);

    // No money yet: nothing to rebuild. Its schedule is BUILT off the series
    // deemed date when it goes live, because materialize reads it from there.
    if (!lineStart) { notYetLive++; continue; }

    // What this line's schedule SHOULD be, anchored on the series close date.
    const want = generateSchedule(
      {
        amount: Number(line.amount),
        coupon_rate_pct: Number(line.coupon_rate_pct),
        payout_frequency: line.payout_frequency as PayoutFrequency,
        tenure_months: Number(line.tenure_months),
        day_count_convention: line.day_count_convention as DayCountConvention,
      },
      { interestStartDate: lineStart, seriesDeemedDate: deemed, holidays, payoutDay, nextBatchFromDay });

    const wantRedemption = want.find((r) => r.due_type === 'Redemption');
    const currentMaturity = iso(line.maturity_date);
    if (wantRedemption && currentMaturity && wantRedemption.due_date === currentMaturity) {
      alreadyRight++; continue;
    }
    // Only ever forward. Shortening a term strands paid rows past the maturity.
    if (wantRedemption && currentMaturity && wantRedemption.due_date < currentMaturity) {
      skips.push(`${line.application_no}: maturity would move EARLIER (${currentMaturity} -> ${wantRedemption.due_date}) — refusing`);
      skipped++; continue;
    }

    const tdsRule = line.scheme_id
      ? (await db.query<Row>('SELECT tr.* FROM schemes s JOIN tds_rules tr ON tr.id = s.tds_rule_id WHERE s.id = $1', [line.scheme_id])).rows[0] ?? DEFAULT_TDS_RULE
      : DEFAULT_TDS_RULE;
    const customer = (await db.query<Row>('SELECT * FROM customers WHERE id = $1', [line.customer_id])).rows[0] ?? {};

    const priced = want.map((r) => {
      const gross = roundRupee(r.gross_amount);
      const tds = roundRupee(computeTds(tdsRule as never, customer, line as never, { ...r, gross_amount: gross }));
      return { due_date: r.due_date, due_type: r.due_type, gross, tds, net: gross - tds };
    });

    const have = (await db.query<Row>(
      `SELECT id, due_date, due_type, gross_amount, status, batch_id FROM disbursement_schedule
        WHERE line_id = $1 ORDER BY due_date`, [lineId])).rows;

    if (!have.length) { notYetLive++; continue; }

    const tail = have.filter((h) => h.due_type === 'Redemption' || h.due_type === 'BrokenInterest');
    const settledTail = tail.find((h) => h.status === 'Paid' || h.batch_id != null);
    if (settledTail) {
      skips.push(`${line.application_no}: its ${String(settledTail.due_type)} row is already ${settledTail.status === 'Paid' ? 'PAID' : 'BATCHED'} — matured, not re-dating it`);
      skipped++; continue;
    }
    if (!tail.length) {
      skips.push(`${line.application_no}: no Redemption row to move`);
      skipped++; continue;
    }

    // Everything that is not the tail stays exactly as it is, whatever engine
    // produced it — that is what protects the already-paid rows.
    const keepKeys = new Set(have.filter((h) => !(h.due_type === 'Redemption' || h.due_type === 'BrokenInterest'))
      .map((h) => `${iso(h.due_date)}|${String(h.due_type)}`));
    const frozen = have.filter((h) => h.status === 'Paid' || h.batch_id != null);
    const toDelete = tail;
    const toInsert = priced.filter((r) => !keepKeys.has(`${r.due_date}|${r.due_type}`));
    const redemption = priced.find((r) => r.due_type === 'Redemption');

    if (!commit) {
      if (moved < 5) {
        console.log(`\n  ${line.application_no} (${line.full_name}) ${line.series_code} Rs ${money(Number(line.amount))}`);
        console.log(`    keep ${have.length - toDelete.length} rows (${frozen.length} paid/batched) · move ${toDelete.length} tail · append ${toInsert.length}`);
        console.log(`    maturity ${currentMaturity ?? '—'} -> ${redemption?.due_date ?? '?'}  (series close ${deemed})`);
      }
      moved++; kept += frozen.length; replaced += toDelete.length; added += toInsert.length;
      continue;
    }

    await db.withTx(async (tx) => {
      // A batch could have been cut since we read: re-assert inside the tx.
      const still = (await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM disbursement_schedule
          WHERE line_id = $1 AND id = ANY($2) AND (status <> 'Scheduled' OR batch_id IS NOT NULL)`,
        [lineId, toDelete.map((d) => Number(d.id))])).rows[0];
      if (Number(still?.n ?? 0) > 0) throw new Error(`${line.application_no}: rows changed under us — aborting this line`);

      await tx.query('DELETE FROM disbursement_schedule WHERE id = ANY($1)', [toDelete.map((d) => Number(d.id))]);

      const bank = line.payout_bank_account_id
        ? (await tx.query<Row>('SELECT account_number, ifsc FROM customer_bank_accounts WHERE id = $1', [line.payout_bank_account_id])).rows[0]
        : (await tx.query<Row>('SELECT account_number, ifsc FROM customer_bank_accounts WHERE customer_id = $1 AND is_active = TRUE LIMIT 1', [line.customer_id])).rows[0];
      for (const r of toInsert) {
        await tx.query(
          `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status, payee_account, payee_ifsc)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'Scheduled',$8,$9)`,
          [lineId, appId, r.due_date, r.due_type, r.gross, r.tds, r.net, bank?.account_number ?? null, bank?.ifsc ?? null]);
      }
      await tx.query('UPDATE application_lines SET maturity_date = $1 WHERE id = $2', [redemption?.due_date ?? null, lineId]);
      if (redemption) {
        // Forward only — a clubbed investment's other tranche must not drag it back.
        await tx.query(
          'UPDATE applications SET maturity_date = $1, updated_at = now() WHERE id = $2 AND (maturity_date IS NULL OR maturity_date < $1)',
          [redemption.due_date, appId]);
      }
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_data, after_data, created_at)
         VALUES ((SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='super_admin' ORDER BY u.id LIMIT 1),
                 'investment.maturity_realigned','application_lines',$1,$2,$3,now())`,
        [String(lineId),
         JSON.stringify({ maturity_date: currentMaturity, schedule_rows_replaced: toDelete.length }),
         JSON.stringify({ maturity_date: redemption?.due_date ?? null, series_close_date: deemed, schedule_rows_written: toInsert.length,
                          note: 'Owner 2026-11-03: the series close date is the allotment date; maturity = close date + tenure. Interest still accrues from each line\'s own money-received date. Paid and batched rows preserved.' })]);
    });
    moved++; kept += frozen.length; replaced += toDelete.length; added += toInsert.length;
  }

  console.log(`\n${commit ? 'REALIGNED' : 'WOULD REALIGN'}: ${moved} line(s)`);
  console.log(`  already on the series date       : ${alreadyRight}`);
  console.log(`  paid/batched rows kept untouched : ${kept}`);
  console.log(`  tail rows moved out              : ${replaced}`);
  console.log(`  rows written                     : ${added}`);
  if (notYetLive) console.log(`  not yet live (built off the series date when the money lands): ${notYetLive}`);
  if (skipped) {
    console.log(`\nSKIPPED ${skipped} line(s) — left exactly as they were:`);
    for (const s of skips.slice(0, 20)) console.log(`  · ${s}`);
  }
  if (!commit) console.log('\nDry run. Re-run with --commit to apply.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
