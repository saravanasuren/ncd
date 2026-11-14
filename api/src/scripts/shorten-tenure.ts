/**
 * shorten-tenure — bring the term of live investments back IN and drop the
 * unpaid part of their schedule beyond the new maturity, leaving everything
 * already paid or already batched exactly as it is.
 *
 * Owner 2026-11-14: "for all the sd1,2,3,4,5 tenure is 36 months, not 60."
 *
 * This REVERSES the 2026-10-31 decision that the subordinate book runs five
 * years. What that decision actually left in the data is a mix:
 *   · extend-tenure.ts was written for it but never run with --commit, so the
 *     July-October money is still 36 months.
 *   · the scheme's tenure WAS changed to 60 in place on 2026-11-02, so
 *     everything enrolled after that came in at 60 — and migration 109 then set
 *     maturity_date = series close date + 60 and named the scheme
 *     "13% - 60 Months - Monthly".
 * So this script's job is the November money and anything else that came in at
 * five years. `--from 60 --to 36` is the whole scope; a line already at 36 is
 * not selected and cannot be touched.
 *
 * WHY THIS IS NOT extend-tenure RUN BACKWARDS. That script refuses outright:
 *
 *   "Refusing: this only ever lengthens a term. Shortening one would strand
 *    paid rows past the new maturity."
 *
 * That is the real hazard and it is the one thing guarded hardest here. If an
 * interest row beyond the new maturity has already been PAID or BATCHED, the
 * money has gone out for a month the investment would no longer run, and no
 * amount of rescheduling undoes it. Such a line is REFUSED and reported, never
 * silently fixed up. (On today's book nothing qualifies — month 37 of the
 * earliest tranche falls in August 2029 — but the guard is what makes the
 * script safe to run again later, when that is no longer true.)
 *
 * WHAT MOVES, and why it is safe:
 *
 *   · every row at or before the new maturity is left exactly as it is,
 *     whatever engine produced it. In particular the opening part-month stub
 *     some older lines carry is never regenerated: extend-tenure found 41 lines
 *     whose row boundaries differ from today's engine for the same money, and
 *     rewriting those would rewrite rows that are already paid;
 *   · every row AFTER the new maturity is deleted — the interest months the
 *     investment no longer runs for, plus the old Redemption and its trailing
 *     BrokenInterest stub;
 *   · the new tail is taken from the app's own generateSchedule at the new
 *     tenure, so the Redemption and closing stub are priced by the same code
 *     the live interest run uses. Nothing is hand-computed.
 *
 * The application's maturity_date is RECOMPUTED as the max across its lines
 * rather than assigned, so a clubbed investment whose other tranche still runs
 * longer is not dragged in with this one.
 *
 * Usage on the box:
 *   unset DATABASE_URL LEGACY_DATABASE_URL
 *   export SSM_PARAMETERS_PATH=/dhanam/newwealth/ SSM_REGION=ap-south-1
 *   node dist/scripts/shorten-tenure.js --series 39,40,41,42,43 --from 60 --to 36 --scheme 13_M36_MONTHLY
 *   node dist/scripts/shorten-tenure.js --series 39,40,41,42,43 --from 60 --to 36 --scheme 13_M36_MONTHLY --commit
 *
 * --scheme also moves each line onto that scheme, in the same transaction as
 * its term. The customer app shows the holder the SCHEME NAME, not the tenure,
 * so without it a corrected line still reads "13% - 60 Months - Monthly".
 *
 * --exclude-scheme leaves named schemes alone entirely. Owner 2026-11-14:
 * "leave the doubling ones out" — 9 lines on "Doubling - 60 Months" (20%
 * AtMaturity) sit inside SD2/SD4/SD5 and must keep their five-year term, since
 * 20% simple over three years returns 60% and a shortened Doubling no longer
 * doubles.
 *
 * Dry run is the default and prints the full tally plus every refusal. Take a
 * backup before --commit: this deletes schedule rows.
 */
import { pathToFileURL } from 'node:url';
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

/** What a run did, so a caller (and the test) can assert on it. */
export type ShortenReport = {
  selected: number; moved: number; skipped: number; notYetLive: number; excluded: number;
  deleted: number; inserted: number; kept: number; skips: string[]; excludedNote: string[];
};

export async function shortenTenure(
  db: Db,
  opts: {
    seriesIds: number[]; fromMonths: number; toMonths: number; commit: boolean;
    quiet?: boolean; schemeCode?: string; excludeSchemeCodes?: string[];
  },
): Promise<ShortenReport> {
  const { seriesIds, fromMonths, toMonths, commit } = opts;
  const log = (...a: unknown[]) => { if (!opts.quiet) console.log(...a); };
  // The mirror of extend-tenure's guard. Lengthening appends and is safe; this
  // deletes, so it must never be handed a longer term by a slip of the flags.
  if (toMonths >= fromMonths) {
    throw new Error('Refusing: this only ever shortens a term. Use extend-tenure.ts to lengthen one.');
  }

  const settings = await getSettingsMap(db);
  const payoutDay = Number(settings['interest.payout_day_of_month'] ?? 28);
  const nextBatchFromDay = Number(settings['interest.next_batch_from_day'] ?? 0) || 0;
  const holidays = (await db.query<{ d: string }>('SELECT d FROM holidays')).rows.map((h) => h.d);

  // THE LABEL THE HOLDER ACTUALLY SEES. /integration/reads.ts sends the customer
  // app `scheme_name`, never tenure_months, and the bond certificate prints the
  // same string in its Scheme row. A line left on "13% - 60 Months - Monthly"
  // still reads as sixty months however correct its dates are (owner
  // 2026-11-14: "it should show 36 months, it showed 60 months"). So the scheme
  // moves in the SAME transaction as the term — never as a separate pass, which
  // would show a 36-month label against a 2031 maturity in between.
  let target: Row | null = null;
  if (opts.schemeCode) {
    target = (await db.query<Row>('SELECT * FROM schemes WHERE code = $1', [opts.schemeCode])).rows[0] ?? null;
    if (!target) throw new Error(`no scheme with code ${opts.schemeCode} (migration 113 creates 13_M36_MONTHLY)`);
    if (Number(target.tenure_months) !== toMonths) {
      throw new Error(`scheme ${opts.schemeCode} is ${target.tenure_months} months, not ${toMonths}`);
    }
  }

  const lines = (await db.query<Row>(
    `SELECT l.*, a.series_id, a.application_no, a.interest_start_date, a.customer_id,
            a.payout_bank_account_id, c.full_name, s.code AS series_code, s.deemed_date,
            sch.code AS scheme_code, sch.name AS scheme_name
       FROM application_lines l
       JOIN applications a ON a.id = l.application_id
       JOIN customers c ON c.id = a.customer_id
       JOIN series s ON s.id = a.series_id
       LEFT JOIN schemes sch ON sch.id = l.scheme_id
      WHERE a.series_id = ANY($1) AND a.archived_at IS NULL AND l.tenure_months = $2
      ORDER BY a.id, l.id`, [seriesIds, fromMonths])).rows;

  log(`${lines.length} line(s) at ${fromMonths} months on series ${seriesIds.join(',')} -> ${toMonths} months`);
  const empty: ShortenReport = { selected: 0, moved: 0, skipped: 0, notYetLive: 0, excluded: 0, deleted: 0, inserted: 0, kept: 0, skips: [], excludedNote: [] };
  if (!lines.length) return empty;

  let moved = 0, skipped = 0, deleted = 0, inserted = 0, kept = 0, notYetLive = 0, excluded = 0;
  const skips: string[] = [];
  const excludedNote: string[] = [];
  const excludeCodes = new Set((opts.excludeSchemeCodes ?? []).map((c) => c.trim()).filter(Boolean));

  for (const line of lines) {
    const appId = Number(line.application_id);
    const lineId = Number(line.id);

    // EXCLUDED BY NAME, not by luck. Owner 2026-11-14: "leave the doubling ones
    // out." The scheme guard below would refuse them today anyway — Doubling is
    // 20% AtMaturity and cannot be relabelled as 13% monthly — but that is a
    // coincidence of the current scheme table, and a 20% 36-month scheme
    // appearing later would silently let them through. Doubling must stay at 60
    // months on its own merits: 20% simple over three years returns 60%, not
    // 100%, so a shortened "Doubling" no longer doubles.
    if (excludeCodes.has(String(line.scheme_code ?? ''))) {
      excluded++;
      if (excludedNote.length < 3) {
        excludedNote.push(`${line.application_no} line ${lineId} on ${String(line.scheme_name ?? line.scheme_code)} — excluded by --exclude-scheme`);
      }
      continue;
    }
    const deemed = iso(line.deemed_date);
    const interestStart = iso(line.interest_start_date) ?? deemed;
    const seriesDeemed = deemed ?? interestStart;
    const lineStart = iso(line.date_money_received) ?? interestStart;
    // No start date means the money has not landed yet — an application still
    // awaiting approval, with no schedule to cut. Its term still has to change:
    // materializeForApplication reads tenure_months off the line, so setting it
    // now means the schedule is BUILT at 36 months when it goes live.
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
    const redemption = priced.find((r) => r.due_type === 'Redemption');
    if (!redemption) {
      skips.push(`${line.application_no} line ${lineId}: the engine produced no Redemption row at ${toMonths} months`);
      skipped++;
      continue;
    }
    const newMaturity = redemption.due_date;

    // A scheme move may change the LABEL and nothing else. The two fields that
    // would quietly alter money are checked against the line's OWN current
    // scheme, per line, not against the one the migration copied from.
    if (target && Number(line.scheme_id) !== Number(target.id)) {
      const cur = (await db.query<Row>('SELECT * FROM schemes WHERE id = $1', [line.scheme_id])).rows[0];
      const differs = !cur
        || String(cur.tds_rule_id ?? '') !== String(target.tds_rule_id ?? '')
        || Number(cur.face_value ?? 0) !== Number(target.face_value ?? 0)
        || String(cur.payout_frequency ?? '') !== String(target.payout_frequency ?? '')
        || Number(cur.coupon_rate_pct ?? 0) !== Number(target.coupon_rate_pct ?? 0);
      if (differs) {
        skips.push(`${line.application_no} line ${lineId}: its scheme ${String(cur?.code ?? line.scheme_id)} differs from `
          + `${String(target.code)} on TDS rule, face value, frequency or rate — REFUSED rather than relabelled`);
        skipped++;
        continue;
      }
    }

    const have = (await db.query<Row>(
      `SELECT id, due_date, due_type, gross_amount, net_amount, status, batch_id FROM disbursement_schedule
        WHERE line_id = $1 ORDER BY due_date`, [lineId])).rows;

    // What the shortened term no longer covers: everything DATED AFTER the new
    // maturity. That is the interest months 37..60, the old Redemption and its
    // trailing stub — selected by date, not by due_type, so the opening
    // part-month stub an older engine may have written is never in scope.
    const past = have.filter((h) => (iso(h.due_date) ?? '') > newMaturity);

    // THE GUARD. Money already paid or already in a batch for a month the
    // investment would no longer run cannot be taken back by rescheduling.
    const settled = past.filter((h) => h.status === 'Paid' || h.batch_id != null);
    if (settled.length) {
      const total = settled.reduce((s, h) => s + Number(h.net_amount || 0), 0);
      skips.push(
        `${line.application_no} line ${lineId}: ${settled.length} row(s) past the new maturity are already `
        + `${settled.some((h) => h.status === 'Paid') ? 'PAID' : 'BATCHED'} (Rs ${money(total)}, `
        + `${iso(settled[0]!.due_date)}..${iso(settled[settled.length - 1]!.due_date)}) — REFUSED, this needs a decision, not a reschedule`);
      skipped++;
      continue;
    }
    // A Redemption already sitting at or before the new maturity means this line
    // is not the shape assumed here. Reported rather than guessed at.
    const earlyRedemption = have.find((h) => h.due_type === 'Redemption' && (iso(h.due_date) ?? '') <= newMaturity);
    if (earlyRedemption) {
      skips.push(`${line.application_no} line ${lineId}: already has a Redemption row on ${iso(earlyRedemption.due_date)}, at or before the new maturity ${newMaturity}`);
      skipped++;
      continue;
    }

    // Everything that stays, untouched — and what the new tail adds on top.
    const keepKeys = new Set(have.filter((h) => !past.includes(h)).map((h) => `${iso(h.due_date)}|${String(h.due_type)}`));
    const frozen = have.filter((h) => h.status === 'Paid' || h.batch_id != null);
    const toInsert = priced.filter((r) => !keepKeys.has(`${r.due_date}|${r.due_type}`));

    if (!commit) {
      if (moved < 3) {
        log(`\n  ${line.application_no} (${line.full_name}) ${line.series_code} Rs ${money(Number(line.amount))}`);
        log(`    keep ${have.length - past.length} existing rows (${frozen.length} paid/batched) · drop ${past.length} past the new maturity · write ${toInsert.length}`);
        log(`    maturity ${iso(line.maturity_date) ?? '—'} -> ${newMaturity}`);
        if (target) log(`    scheme   ${String(line.scheme_id)} -> ${String(target.code)} ("${String(target.name)}")`);
      }
      moved++; kept += frozen.length; deleted += past.length; inserted += toInsert.length;
      continue;
    }

    await db.withTx(async (tx) => {
      // Re-check inside the transaction: a batch could have been cut since the
      // guard above ran. This is the same money question, asked atomically.
      const still = (await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM disbursement_schedule
          WHERE line_id = $1 AND id = ANY($2) AND (status <> 'Scheduled' OR batch_id IS NOT NULL)`,
        [lineId, past.map((d) => Number(d.id))])).rows[0];
      if (Number(still?.n ?? 0) > 0) throw new Error(`${line.application_no}: rows changed under us — aborting this line`);

      if (past.length) {
        await tx.query('DELETE FROM disbursement_schedule WHERE id = ANY($1)', [past.map((d) => Number(d.id))]);
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
      await tx.query(
        `UPDATE application_lines SET tenure_months = $1, maturity_date = $2,
                scheme_id = COALESCE($4, scheme_id) WHERE id = $3`,
        [toMonths, newMaturity, lineId, target ? Number(target.id) : null]);
      // RECOMPUTED, not assigned: a clubbed investment's other tranche may still
      // run longer, and the application matures when its last line does. The
      // extend script could move this forward unconditionally; coming back in,
      // only the max across the lines is correct.
      await tx.query(
        `UPDATE applications a
            SET maturity_date = (SELECT max(l.maturity_date) FROM application_lines l WHERE l.application_id = a.id),
                updated_at = now()
          WHERE a.id = $1`, [appId]);
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_data, after_data, created_at)
         VALUES ((SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='super_admin' ORDER BY u.id LIMIT 1),
                 'investment.tenure_shortened','application_lines',$1,$2,$3,now())`,
        [String(lineId),
         JSON.stringify({ tenure_months: fromMonths, maturity_date: iso(line.maturity_date), scheme_id: Number(line.scheme_id), schedule_rows_deleted: past.length }),
         JSON.stringify({ tenure_months: toMonths, maturity_date: newMaturity, scheme_id: target ? Number(target.id) : Number(line.scheme_id),
                          scheme_name: target ? String(target.name) : null, schedule_rows_written: toInsert.length,
                          note: 'Owner 2026-11-14: SD1-SD5 run 36 months, not 60 — reversing the 2026-10-31 five-year decision. Tenure only: rate, frequency, amounts and the money-received date unchanged. Paid and batched rows preserved; any line with settled money past the new maturity was refused.' })]);
    });
    moved++; kept += frozen.length; deleted += past.length; inserted += toInsert.length;
  }

  log(`\n${commit ? 'COMMITTED' : 'DRY RUN'}: ${moved} line(s) shortened to ${toMonths} months`
    + ` · ${deleted} schedule row(s) dropped · ${inserted} written · ${kept} paid/batched row(s) preserved`
    + (notYetLive ? ` · ${notYetLive} not yet live (term set, schedule builds at ${toMonths} on activation)` : '')
    + (excluded ? ` · ${excluded} excluded by scheme` : '')
    + (skipped ? ` · ${skipped} REFUSED` : ''));
  if (excludedNote.length) {
    log(`\nExcluded (${excluded} line(s), left at ${fromMonths} months):`);
    for (const e of excludedNote) log(`  · ${e}`);
  }
  if (skips.length) {
    log('\nRefused:');
    for (const s of skips) log(`  · ${s}`);
  }
  if (!commit) log('\nNothing was changed. Re-run with --commit to apply — take a backup first, this deletes schedule rows.');
  return { selected: lines.length, moved, skipped, notYetLive, excluded, deleted, inserted, kept, skips, excludedNote };
}

async function main(): Promise<void> {
  const seriesIds = (arg('series') ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  const fromMonths = Number(arg('from', '60'));
  const toMonths = Number(arg('to', '36'));
  if (!seriesIds.length || !fromMonths || !toMonths) {
    console.error('usage: --series 40,41,42,43,44 --from 60 --to 36 [--scheme 13_M36_MONTHLY] [--exclude-scheme 20%] [--commit]');
    process.exit(1);
  }
  await loadSecretsFromSsm();
  await shortenTenure(createDb(), {
    seriesIds, fromMonths, toMonths, commit: process.argv.includes('--commit'),
    schemeCode: arg('scheme'),
    excludeSchemeCodes: (arg('exclude-scheme') ?? '').split(',').map((c) => c.trim()).filter(Boolean),
  });
}

// Only when actually RUN as a script. Importing this module (the tests drive
// shortenTenure directly) must not start a run or call process.exit.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry && import.meta.url === entry) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
