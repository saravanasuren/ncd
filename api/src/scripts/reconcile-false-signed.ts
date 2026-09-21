/**
 * reconcile-false-signed — locker agreements that SAY "Signed" and are not.
 *
 * WHY THIS EXISTS. Until #450 (18 Sep) every load of the enrolment or profile
 * page ran syncFromEsignStatus, which stamped a NATIVE (our own Digio)
 * agreement `Signed` whenever LockerHub's separate e-Sign status read "signed" —
 * with no Digio signature recorded and no file. #450 stopped new rows being
 * corrupted; the rows already flipped kept the claim. They read "e-Signed" on
 * Locker Tenants and the profile, and "View signed agreement" has nothing to
 * open.
 *
 * WHICH ROWS: status 'Signed', method 'esign', with Digio sessions of our own,
 * and NO session recorded as signed. (A row with a signed session is backed by
 * evidence; a row with no sessions at all is a LockerHub-signed one and is left
 * alone.)
 *
 * WHAT IT DOES, per row — the same reconcileSignedClaim a click runs:
 *   recovered   Digio HAS the signature (unrecorded — the poller was blind until
 *               #451). Recorded through the normal path: file stored, status set
 *               to where the chain really is (customer signed → awaiting signatory).
 *   lockerhub   LockerHub says signed. The old flip was right; left alone (a click
 *               will serve their copy).
 *   unsupported Digio AND LockerHub both read, neither has a signature. The row
 *               stops claiming it: back to AwaitingSignature, evidence in the audit.
 *   unknown     Either side could not be asked. NOTHING is changed.
 *
 * Run `reconcile:digio` first if it has not been run: it records the signatures
 * Digio already holds, so this only has to deal with what is left.
 *
 * DRY-RUN (default): reads Digio and LockerHub, prints the verdict, writes nothing.
 * COMMIT (--commit): applies it.
 *
 *   cd ~/ncd/api && set -a && . ./.env && set +a
 *   node dist/scripts/reconcile-false-signed.js            # dry-run
 *   node dist/scripts/reconcile-false-signed.js --commit   # apply
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await loadSecretsFromSsm();
  const db = createDb();
  const { reconcileSignedClaim, listFalselySigned } = await import('../modules/lockers/agreements.js');

  const rows = await listFalselySigned(db);

  console.log(`[reconcile-false-signed] ${commit ? 'COMMIT' : 'DRY-RUN'} — ${rows.length} agreement(s) say Signed with no Digio signature recorded`);
  const tally: Record<string, number> = { recovered: 0, lockerhub: 0, unsupported: 0, unknown: 0 };
  for (const r of rows) {
    const who = `${r.lockerhub_application_id} ${r.customer_name ?? ''}`.trim();
    try {
      const v = await reconcileSignedClaim(db, null, r.lockerhub_application_id, { apply: commit });
      tally[v.verdict]!++;
      const detail = v.verdict === 'unknown' ? ` — ${v.why}`
        : v.verdict === 'unsupported' ? ` — Digio: [${v.digio.join(', ') || 'no open session'}], LockerHub: not signed` : '';
      console.log(`  ${v.verdict.toUpperCase().padEnd(11)} ${who}${detail}`);
    } catch (e) {
      tally.unknown!++;
      console.error(`  ERROR       ${who}: ${(e as Error).message}`);
    }
    await sleep(3500);   // Digio 429s a burst
  }

  console.log(`\n[reconcile-false-signed] ${tally.recovered} recovered, ${tally.lockerhub} LockerHub-backed (left alone), `
    + `${tally.unsupported} unsupported, ${tally.unknown} unknown (unchanged)`);
  if (!commit) console.log('[reconcile-false-signed] dry-run only — re-run with --commit to apply.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
