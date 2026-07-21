/**
 * rematerialize-application — regenerate one application's disbursement schedule
 * from its CURRENT series/interest_start (e.g. after a series correction). Uses
 * the real materializeForApplication so the schedule, TDS and maturity match a
 * fresh go-live.
 *
 * DRY-RUN (default): shows what it would do. COMMIT (--commit): deletes the
 * app's existing (unpaid) schedule and re-materialises, in one transaction.
 * Refuses if any schedule row for the app is already Paid.
 *
 * Usage on the box (DATABASE_URL from SSM, like deploy.sh):
 *   unset DATABASE_URL LEGACY_DATABASE_URL; export SSM_PARAMETERS_PATH=/dhanam/newwealth/
 *   node dist/scripts/rematerialize-application.js APP-2026-000646
 *   node dist/scripts/rematerialize-application.js APP-2026-000646 --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { materializeForApplication } from '../modules/schedule/materialize.js';

async function main(): Promise<void> {
  const appNo = process.argv.find((a) => a.startsWith('APP-'));
  const commit = process.argv.includes('--commit');
  if (!appNo) { console.error('Pass an application number, e.g. APP-2026-000646'); process.exit(1); }
  await loadSecretsFromSsm();
  const db = createDb();

  const app = (await db.query<{ id: string; series_code: string; interest_start_date: string; status: string; paid: string; sched: string }>(
    `SELECT a.id, s.code AS series_code, a.interest_start_date, a.status,
            (SELECT count(*) FROM disbursement_schedule d WHERE d.application_id=a.id AND d.status='Paid') AS paid,
            (SELECT count(*) FROM disbursement_schedule d WHERE d.application_id=a.id) AS sched
       FROM applications a JOIN series s ON s.id=a.series_id WHERE a.application_no=$1`, [appNo])).rows[0];
  if (!app) { console.error(`No application ${appNo}`); process.exit(1); }
  console.log(`[rematerialize] ${appNo} — series=${app.series_code} interest_start=${String(app.interest_start_date).slice(0,10)} status=${app.status} existing_rows=${app.sched} paid=${app.paid}`);
  if (Number(app.paid) > 0) { console.error('Refusing: this application has Paid schedule rows.'); process.exit(1); }
  if (!commit) { console.log('[rematerialize] dry-run only — re-run with --commit to apply.'); return; }

  const rows = await db.withTx(async (tx) => {
    await tx.query('DELETE FROM disbursement_schedule WHERE application_id=$1', [Number(app.id)]);
    return materializeForApplication(tx, Number(app.id));
  });
  console.log(`[rematerialize] done — ${rows} schedule rows generated for ${appNo}.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
