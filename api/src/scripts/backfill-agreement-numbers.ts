/**
 * backfill-agreement-numbers — give every existing locker application its DIF
 * number, oldest first (owner 2026-09-17).
 *
 * The Schedule used to print the raw LockerHub application id, so agreements
 * already on the book carry "mu57ytsh53ldvkg" where their number belongs. Those
 * get numbered too, in creation order, so the book reads consistently.
 *
 * ⚠️ An agreement that has ALREADY BEEN SIGNED keeps its signed copy unchanged —
 * that file is stored and is the executed document. Numbering it here only
 * affects what a FRESH render shows, so a reprint of an old agreement will carry
 * a number its signed copy does not. Called out because it is a real
 * inconsistency, accepted deliberately: most of these are test records, and a
 * book with two styles of number is worse.
 *
 * Runs through ensureAgreementNo, so it takes the same row lock and the same
 * one-number-per-locker guarantee as a live render. Idempotent: an application
 * that already has a number is skipped, not renumbered.
 *
 * DRY-RUN (default): lists what each would get. COMMIT (--commit): allocates.
 *
 *   unset DATABASE_URL LEGACY_DATABASE_URL
 *   node dist/scripts/backfill-agreement-numbers.js            # dry-run
 *   node dist/scripts/backfill-agreement-numbers.js --commit   # apply
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await loadSecretsFromSsm();
  const db = createDb();
  const { ensureAgreementNo } = await import('../modules/lockers/agreements.js');

  const { rows } = await db.query<{ id: string; created_at: string; customer_name: string | null; locker_number: string | null; agreement_no: string | null }>(
    `SELECT lockerhub_application_id AS id, created_at, customer_name, locker_number, agreement_no
       FROM locker_applications ORDER BY created_at, lockerhub_application_id`);

  const pending = rows.filter((r) => !String(r.agreement_no ?? '').trim());
  console.log(`[backfill-agreement-numbers] ${commit ? 'COMMIT' : 'DRY-RUN'} — ${rows.length} application(s), ${pending.length} without a number`);
  for (const r of rows.filter((x) => x.agreement_no)) {
    console.log(`  keeps ${r.agreement_no}  ${r.id}  ${r.customer_name ?? '—'}`);
  }
  for (const r of pending) {
    console.log(`  to number  ${r.id}  ${String(r.created_at).slice(0, 10)}  ${r.customer_name ?? '—'}  ${r.locker_number ?? '—'}`);
  }
  if (!commit) { console.log('[backfill-agreement-numbers] dry-run only — re-run with --commit to apply.'); return; }

  // Oldest first, one at a time: the sequence must hand them out in creation
  // order, which a concurrent loop would not guarantee.
  for (const r of pending) {
    const no = await ensureAgreementNo(db, r.id);
    console.log(`  ${no ?? 'FAILED'}  ${r.id}  ${r.customer_name ?? '—'}`);
  }
  const left = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM locker_applications WHERE btrim(coalesce(agreement_no,'')) = ''`)).rows[0]!.n;
  console.log(`[backfill-agreement-numbers] done — still without a number: ${left}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
