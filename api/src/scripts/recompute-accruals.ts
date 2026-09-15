/**
 * recompute-accruals — (re)create incentive accruals for live applications
 * whose referrer was set or changed AFTER their accrual was first snapshotted
 * (accruals are created at activation and don't recompute when the book changes;
 * e.g. a Direct-backfill that filled in a referrer later).
 *
 * It runs the REAL accrueForApplication, which creates any MISSING accrual,
 * never duplicates one, and REFRESHES an unpaid one whose amount no longer
 * matches the investment (see modules/incentives/accrual.ts). A PAID accrual is
 * never touched. It does not delete accruals; a referrer that changed to a
 * different payee keeps its old row (out of scope here — those are handled by
 * explicit agent-merge repoints).
 *
 * DRY-RUN (default): lists the apps in scope AND what each accrual would become;
 * writes nothing.
 * COMMIT (--commit): runs the accrual for each, one transaction per app.
 *
 * Scope:
 *   default          live apps with a referrer but ZERO accruals
 *   --all            every live app
 *   --app A,B,C      exactly these application numbers — use this for a known
 *                    short list rather than --all, which would re-price every
 *                    unpaid accrual on the book against today's matrix settings.
 *
 * Usage on the box (DATABASE_URL comes from SSM, mirroring deploy.sh):
 *   unset DATABASE_URL LEGACY_DATABASE_URL
 *   node dist/scripts/recompute-accruals.js --app APP-2026-001105            # dry-run
 *   node dist/scripts/recompute-accruals.js --app APP-2026-001105 --commit   # apply
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { accrueForApplication } from '../modules/incentives/accrual.js';

const LIVE = "a.status IN ('PendingFundVerification','PendingEsign','PendingActivation','PendingAllotment','Active')";

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const all = process.argv.includes('--all');
  const appArg = process.argv[process.argv.indexOf('--app') + 1];
  const only = process.argv.includes('--app') && appArg && !appArg.startsWith('--')
    ? appArg.split(',').map((x) => x.trim()).filter(Boolean)
    : null;
  if (process.argv.includes('--app') && !only?.length) {
    throw new Error('--app needs a comma-separated list of application numbers');
  }
  await loadSecretsFromSsm();
  const db = createDb();

  const params: unknown[] = [];
  let scope: string;
  if (only) {
    // Named applications only — NOT filtered by LIVE, because the whole point is
    // to correct a specific row somebody has already looked at.
    params.push(only);
    scope = 'a.application_no = ANY($1::text[])';
  } else if (all) {
    scope = LIVE;
  } else {
    scope = `${LIVE} AND btrim(coalesce(a.referred_by_text,'')) <> '' `
      + `AND NOT EXISTS (SELECT 1 FROM incentive_accruals ia WHERE ia.application_id = a.id)`;
  }

  const { rows } = await db.query<{ id: string; application_no: string; amount: string; referred_by_text: string | null }>(
    `SELECT a.id, a.application_no, a.total_amount AS amount, a.referred_by_text
       FROM applications a JOIN customers c ON c.id = a.customer_id
      WHERE ${scope} ORDER BY a.application_no`, params
  );
  if (only) {
    const missing = only.filter((n) => !rows.some((r) => r.application_no === n));
    if (missing.length) throw new Error(`no such application: ${missing.join(', ')}`);
  }

  const label = only ? `named: ${only.join(', ')}` : all ? 'all live' : 'missing-accrual';
  console.log(`[recompute-accruals] ${commit ? 'COMMIT' : 'DRY-RUN'} — ${rows.length} app(s) in scope (${label})`);
  for (const r of rows) {
    console.log(`  ${r.application_no}  ₹${Number(r.amount).toLocaleString('en-IN')}  ref=${(r.referred_by_text ?? '').trim() || '—'}`);
  }

  /** What the accruals look like right now — printed before and after, so the
   *  run reports the change rather than asserting it happened. */
  const snapshot = async () => (await db.query<Record<string, unknown>>(
    `SELECT a.application_no, ia.payee_type, ia.payee_id, ia.matrix_cell,
            ia.rate_mode, ia.rate_value::float8 AS rate_value, ia.amount::float8 AS amount,
            ia.accrual_date, ia.paid_at
       FROM incentive_accruals ia JOIN applications a ON a.id = ia.application_id
      WHERE a.id = ANY($1::bigint[]) ORDER BY a.application_no, ia.id`,
    [rows.map((r) => Number(r.id))])).rows;
  console.log('[recompute-accruals] accruals BEFORE:');
  console.table(await snapshot());
  if (!commit) {
    console.log('[recompute-accruals] dry-run only — re-run with --commit to apply.');
    return;
  }

  let done = 0;
  for (const r of rows) {
    await db.withTx(async (tx) => { await accrueForApplication(tx, Number(r.id)); });
    done++;
  }
  console.log('[recompute-accruals] accruals AFTER:');
  console.table(await snapshot());
  console.log(`[recompute-accruals] done — accrual run for ${done} app(s) (missing rows created, unpaid rows refreshed, PAID rows untouched).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
