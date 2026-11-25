/**
 * reaccrue-application — re-run the incentive engine over named investments.
 *
 * WHY. An investment booked while its customer had no referrer on file earns
 * nothing for anybody: the engine reads the referrer at the time, and if the
 * name is added to the customer afterwards nothing re-runs. Two live
 * investments were in that state on 2026-11-25 — APP-2026-001160 and
 * APP-2026-001257, both Rs 1,00,000, both with no enroller and a referrer that
 * reached the customer later. Their sibling investments, same customer and
 * same referrer, all carry a `referrer` accrual.
 *
 * IT CALLS THE REAL ENGINE (accrueForApplication) rather than writing a row.
 * A hand-computed incentive is a number nobody can reproduce; this one comes
 * out of the same matrix, the same new-vs-existing question and the same
 * rounding as every other accrual on the book, and the engine's own ON
 * CONFLICT clause means running it twice changes nothing.
 *
 * IT CANNOT OVERWRITE A PAID ROW: the engine's upsert carries
 * `WHERE paid_at IS NULL`, so an incentive already paid out stays as it is.
 *
 * DRY-RUN by default — it shows what each application would gain and rolls
 * back. --commit applies.
 *
 *   node dist/scripts/reaccrue-application.js APP-2026-001160 APP-2026-001257
 *   node dist/scripts/reaccrue-application.js APP-2026-001160 --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { accrueForApplication } from '../modules/incentives/accrual.js';

const inr = (v: unknown) => 'Rs ' + Number(v ?? 0).toLocaleString('en-IN');

async function main(): Promise<void> {
  const appNos = process.argv.filter((a) => a.startsWith('APP-'));
  const commit = process.argv.includes('--commit');
  if (!appNos.length) { console.error('Pass one or more application numbers, e.g. APP-2026-001160'); process.exit(1); }
  await loadSecretsFromSsm();
  const db = createDb();

  for (const appNo of appNos) {
    const app = (await db.query<{ id: string; status: string; total_amount: string }>(
      'SELECT id, status, total_amount FROM applications WHERE application_no = $1', [appNo])).rows[0];
    if (!app) { console.error(`[reaccrue] no application ${appNo}`); continue; }

    const before = (await db.query<Record<string, unknown>>(
      `SELECT payee_type, payee_id, matrix_cell, amount, paid_at
         FROM incentive_accruals WHERE application_id = $1 ORDER BY id`, [Number(app.id)])).rows;
    console.log(`\n[reaccrue] ${appNo} — ${app.status}, ${inr(app.total_amount)}, ${before.length} accrual row(s) now`);
    for (const r of before) console.log(`    existing: ${r.payee_type}#${r.payee_id} ${r.matrix_cell} ${inr(r.amount)}${r.paid_at ? ' (PAID)' : ''}`);

    const ROLLBACK = Symbol('rollback');
    try {
      await db.withTx(async (tx) => {
        await accrueForApplication(tx, Number(app.id));
        const after = (await tx.query<Record<string, unknown>>(
          `SELECT payee_type, payee_id, matrix_cell, amount
             FROM incentive_accruals WHERE application_id = $1 ORDER BY id`, [Number(app.id)])).rows;
        for (const r of after) console.log(`    after   : ${r.payee_type}#${r.payee_id} ${r.matrix_cell} ${inr(r.amount)}`);
        if (!after.length) console.log('    after   : still nothing — the engine books no incentive for this one');
        if (!commit) throw ROLLBACK;
      });
      if (commit) console.log('    committed.');
    } catch (e) {
      if (e !== ROLLBACK) throw e;
      console.log('    dry-run — rolled back. Re-run with --commit to apply.');
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
