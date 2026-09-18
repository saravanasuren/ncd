/**
 * push-agreement-numbers — put every DIF agreement number on LockerHub (A28),
 * then READ EACH ONE BACK to confirm it landed (owner 2026-09-18).
 *
 * New numbers are pushed automatically when they are allocated. This script is
 * for the ones allocated before A28 existed (DIF0001 onward) and for any push
 * that failed. It runs A28 BEFORE any signed-agreement report (A24), as
 * LockerHub asked, so every signature they record already carries its number.
 *
 * The read-back is the point. A 200 says they accepted the call; A8's
 * `external_agreement_no` says what they actually hold. Only the second answers
 * the question the owner asked — "does LockerHub say the same".
 *
 * Refusals (409) are reported and NOT retried: a conflict means they hold a
 * different number, or another application holds this one. They never
 * overwrite, by our own request, so a person has to decide which is right.
 *
 *   node dist/scripts/push-agreement-numbers.js            # dry-run: what would go
 *   node dist/scripts/push-agreement-numbers.js --commit   # push + read back
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await loadSecretsFromSsm();
  const db = createDb();
  const { pushAgreementNo } = await import('../modules/lockers/agreements.js');
  const lh = await import('../integrations/lockerhub/client.js');
  if (!lh.lockerHubConfigured()) throw new Error('LockerHub is not configured on this box');

  // A real person on LockerHub's audit trail, not the automatic identity.
  const su = (await db.query<{ id: string; email: string; full_name: string }>(
    `SELECT u.id, u.email, u.full_name FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'super_admin' AND u.is_active ORDER BY u.id LIMIT 1`)).rows[0];
  if (!su) throw new Error('no active super_admin to attribute the push to');
  const staff = { id: String(su.id), name: su.full_name, email: su.email, staff_role: 'super_admin' };

  const rows = (await db.query<{ id: string; agreement_no: string; customer_name: string | null; pushed: boolean; err: string | null }>(
    `SELECT lockerhub_application_id AS id, agreement_no, customer_name,
            agreement_no_pushed_at IS NOT NULL AS pushed, agreement_no_push_error AS err
       FROM locker_applications WHERE agreement_no IS NOT NULL ORDER BY agreement_no`)).rows;
  const todo = rows.filter((r) => !r.pushed);
  console.log(`[push-agreement-numbers] ${commit ? 'COMMIT' : 'DRY-RUN'} — ${rows.length} numbered, ${todo.length} not yet on LockerHub`);
  for (const r of todo) console.log(`  ${r.agreement_no}  ${r.id}  ${r.customer_name ?? '—'}${r.err ? `   (last try: ${r.err})` : ''}`);
  if (!commit) { console.log('[push-agreement-numbers] dry-run only — re-run with --commit to apply.'); return; }

  const tally: Record<string, number> = {};
  for (const r of todo) {
    const out = await pushAgreementNo(db, r.id, staff);
    tally[out.outcome] = (tally[out.outcome] ?? 0) + 1;
    console.log(`  ${out.outcome.padEnd(8)} ${r.agreement_no}  ${r.id}${'detail' in out ? `  — ${out.detail}` : ''}`);
  }
  console.log('[push-agreement-numbers] outcomes:', JSON.stringify(tally));

  // Read back EVERY numbered application, not just this run's — the question is
  // what LockerHub holds, whoever sent it.
  console.log('[push-agreement-numbers] reading back from LockerHub (A8 external_agreement_no)…');
  let match = 0; const wrong: string[] = [];
  for (const r of rows) {
    const app = await lh.getLockerApplication(r.id).catch((e: Error) => ({ __err: e.message }) as Record<string, unknown>);
    const theirs = String((app as Record<string, unknown>).external_agreement_no ?? '').trim().toUpperCase();
    if (theirs === r.agreement_no.toUpperCase()) match++;
    else wrong.push(`  ${r.agreement_no}  ${r.id}  LockerHub holds "${theirs || ((app as Record<string, unknown>).__err ? `ERROR ${String((app as Record<string, unknown>).__err)}` : '(nothing)')}"`);
  }
  console.log(`[push-agreement-numbers] LockerHub matches ours on ${match} of ${rows.length}`);
  if (wrong.length) { console.log('[push-agreement-numbers] DOES NOT MATCH:'); for (const w of wrong) console.log(w); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
