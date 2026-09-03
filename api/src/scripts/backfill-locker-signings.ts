/**
 * Backfill the locker agreement signing record (owner 2026-09-03).
 *
 * Every locker signed before migration 082 has no row, so "which lockers were
 * signed on paper?" would read blank for the whole back book — and worse, an
 * already-e-Signed locker would offer staff the choice again.
 *
 * Walks the LockerHub tenant roster, asks each application for its e-Sign
 * status, and writes a `method='esign'` row for the ones they report signed.
 * Anything they report as pending or unknown is LEFT ALONE rather than guessed
 * at: a blank record is honest, an invented one is not.
 *
 *   node dist/scripts/backfill-locker-signings.js            # dry run
 *   node dist/scripts/backfill-locker-signings.js --commit
 */
import { createDb } from '../db/index.js';
import * as lh from '../integrations/lockerhub/client.js';

const COMMIT = process.argv.includes('--commit');

async function main() {
  if (!lh.lockerHubConfigured()) {
    console.error('LOCKERHUB_API_URL is not set — nothing to read from.');
    process.exitCode = 1;
    return;
  }
  const db = createDb();

  // The roster is the only list of locker applications we can see; LockerHub
  // owns the applications themselves.
  const roster = await lh.lockerTenants().catch((e: unknown) => {
    console.error(`Could not read the tenant roster: ${(e as Error).message}`);
    return null;
  });
  const rows = (roster as { tenants?: Array<Record<string, unknown>> } | null)?.tenants ?? [];
  if (!rows.length) { console.log('No locker tenants returned — nothing to do.'); await db.close(); return; }

  const appIds = [...new Set(rows
    .map((r) => String(r.application_id ?? r.locker_application_id ?? '').trim())
    .filter(Boolean))];
  console.log(`${appIds.length} locker applications on the roster — ${COMMIT ? 'COMMITTING' : 'DRY RUN'}\n`);

  let wrote = 0, already = 0, notSigned = 0, failed = 0;

  for (const appId of appIds) {
    const existing = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM locker_agreement_signings
        WHERE lockerhub_application_id = $1
          AND status IN ('Draft','AwaitingSignature','PendingApproval','Signed')`, [appId])).rows[0]?.n ?? 0;
    if (existing) { already++; continue; }

    const st = await lh.esignStatus(appId).catch(() => null) as Record<string, unknown> | null;
    const state = String(st?.status ?? '').toLowerCase();
    if (st == null) { failed++; console.log(`  ${appId}  — could not read status, skipped`); continue; }
    if (state !== 'signed' && state !== 'completed') { notSigned++; continue; }

    const ref = (st.esign_id ?? st.id) as string | undefined;
    if (COMMIT) {
      await db.query(
        `INSERT INTO locker_agreement_signings
           (lockerhub_application_id, method, status, esign_reference, signed_at)
         VALUES ($1, 'esign', 'Signed', $2, now())`, [appId, ref ?? null]);
    }
    wrote++;
    console.log(`  ${appId}  → e-Signed${ref ? ` (${ref})` : ''}`);
  }

  console.log(`\n  recorded as e-Signed : ${wrote}`);
  console.log(`  already had a record : ${already}`);
  console.log(`  not signed yet       : ${notSigned}   (left blank on purpose)`);
  console.log(`  status unreadable    : ${failed}`);
  console.log(COMMIT ? '\nCOMMITTED.' : '\nDRY RUN — nothing was written. Pass --commit.');
  await db.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
