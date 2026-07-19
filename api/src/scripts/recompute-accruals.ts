/**
 * recompute-accruals — (re)create incentive accruals for live applications
 * whose referrer was set or changed AFTER their accrual was first snapshotted
 * (accruals are created at activation and don't recompute when the book changes;
 * e.g. a Direct-backfill that filled in a referrer later).
 *
 * It runs the REAL accrueForApplication, which is idempotent per (application,
 * payee) — so it creates any MISSING accrual and never duplicates an existing
 * one. It does not delete accruals; a referrer that changed to a different
 * payee keeps its old row (out of scope here — those are handled by explicit
 * agent-merge repoints).
 *
 * DRY-RUN (default): lists the apps in scope; writes nothing.
 * COMMIT (--commit): runs the accrual for each, one transaction per app.
 * Scope: default = live apps with a referrer but ZERO accruals; --all = every
 * live app (still idempotent).
 *
 * Usage on the box (DATABASE_URL comes from SSM, mirroring deploy.sh):
 *   unset DATABASE_URL LEGACY_DATABASE_URL
 *   node dist/scripts/recompute-accruals.js            # dry-run
 *   node dist/scripts/recompute-accruals.js --commit   # apply
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { accrueForApplication } from '../modules/incentives/accrual.js';

const LIVE = "a.status IN ('PendingFundVerification','PendingEsign','PendingActivation','PendingAllotment','Active')";

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const all = process.argv.includes('--all');
  await loadSecretsFromSsm();
  const db = createDb();

  const scope = all
    ? LIVE
    : `${LIVE} AND btrim(coalesce(a.referred_by_text,'')) <> '' ` +
      `AND NOT EXISTS (SELECT 1 FROM incentive_accruals ia WHERE ia.application_id = a.id)`;

  const { rows } = await db.query<{ id: string; application_no: string; amount: string; referred_by_text: string | null }>(
    `SELECT a.id, a.application_no, a.total_amount AS amount, a.referred_by_text
       FROM applications a JOIN customers c ON c.id = a.customer_id
      WHERE ${scope} ORDER BY a.application_no`
  );

  console.log(`[recompute-accruals] ${commit ? 'COMMIT' : 'DRY-RUN'} — ${rows.length} app(s) in scope (${all ? 'all live' : 'missing-accrual'})`);
  for (const r of rows) {
    console.log(`  ${r.application_no}  ₹${Number(r.amount).toLocaleString('en-IN')}  ref=${(r.referred_by_text ?? '').trim() || '—'}`);
  }
  if (!commit) {
    console.log('[recompute-accruals] dry-run only — re-run with --commit to apply.');
    return;
  }

  let done = 0;
  for (const r of rows) {
    await db.withTx(async (tx) => { await accrueForApplication(tx, Number(r.id)); });
    done++;
  }
  console.log(`[recompute-accruals] done — accrual run for ${done} app(s) (idempotent; missing rows created, existing untouched).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
