/**
 * reconcile-digio-signatures — catch up on signatures Digio recorded and we
 * never heard about (incident 2026-09-18).
 *
 * WHY THIS EXISTS. `fetchStatus` called `POST /v2/client/document/status`, which
 * Digio answers **405 Method Not Allowed**, and the callers swallowed that with
 * `.catch(() => null)`. So an unreachable Digio and "the customer has not signed
 * yet" produced the identical answer, and the 15-second poller reported a quiet
 * day for weeks. Asked against Digio's own records, 66 sessions we still called
 * 'requested' were really:
 *
 *   completed  8   ← signatures that arrived and were never recorded: two NCD
 *                    application forms, three locker agreements, three consents
 *   expired   36   ← dead links still telling staff "waiting for them to sign"
 *   requested 22
 *
 * The endpoint is fixed, so the poller will now find these on its own — but it
 * only looks back POLL_WINDOW_DAYS (7), and most of this backlog is older than
 * that. Hence a one-off pass with no age cutoff.
 *
 * WHAT IT DOES, per session, entirely through the normal paths:
 *   completed → completeSigning(), which stamps esigned_at / signing_method,
 *               pulls the signed PDF, generates the bond, activates a locker
 *               authorised user, or advances a locker agreement's chain — the
 *               same work the webhook does. Idempotent.
 *   expired / declined → markSessionFailed(), so screens stop saying "waiting".
 *   still requested → left alone.
 *
 * It can only ever record what Digio reports. There is no path here that marks
 * an unsigned document signed.
 *
 * PACED: Digio rate-limits a burst (429). One request at a time with a gap, and
 * a 429 is retried rather than counted as "not signed" — mistaking a rate limit
 * for an answer is the whole reason this script is needed.
 *
 * DRY-RUN (default): asks Digio and prints what it WOULD do, writing nothing.
 * COMMIT (--commit): applies it.
 *
 *   cd ~/ncd/api && set -a && . ./.env && set +a
 *   node dist/scripts/reconcile-digio-signatures.js            # dry-run
 *   node dist/scripts/reconcile-digio-signatures.js --commit   # apply
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

interface Row {
  id: string;
  digio_request_id: string;
  document_type: string;
  application_no: string | null;
  customer: string | null;
  locker_agreement_signing_id: string | null;
  locker_authorised_user_id: string | null;
  created_at: string;
}

/** Ask Digio, retrying a rate limit. Returns null only if it stayed unreadable
 *  — which is reported as unreadable, never as unsigned. */
async function statusOf(fetchStatus: (id: string) => Promise<string | null>,
  isRateLimited: (e: unknown) => boolean, id: string): Promise<{ status: string | null; error?: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return { status: await fetchStatus(id) };
    } catch (e) {
      if (isRateLimited(e)) { await sleep(8000); continue; }
      return { status: null, error: (e as Error).message };
    }
  }
  return { status: null, error: 'rate-limited after 4 attempts' };
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await loadSecretsFromSsm();
  const db = createDb();
  const { fetchStatus, isRateLimited, isSignedStatus, isFailedStatus, digioConfigured } = await import('../integrations/digio/index.js');
  if (!digioConfigured()) { console.error('[reconcile-digio] no DIGIO credentials — nothing to do.'); return; }
  const { completeSigning, markSessionFailed } = await import('../integrations/digio/service.js');

  const { rows } = await db.query<Row>(
    `SELECT s.id, s.digio_request_id, s.document_type, s.locker_agreement_signing_id,
            s.locker_authorised_user_id, s.created_at,
            a.application_no, c.full_name AS customer
       FROM digio_signing_sessions s
       LEFT JOIN applications a ON a.id = s.application_id
       LEFT JOIN customers c ON c.id = a.customer_id
      WHERE s.status = 'requested' AND s.digio_request_id IS NOT NULL
      ORDER BY s.id`);

  console.log(`[reconcile-digio] ${commit ? 'COMMIT' : 'DRY-RUN'} — asking Digio about ${rows.length} session(s) we call 'requested'`);
  const signed: Row[] = [];
  const dead: Array<Row & { digio: string }> = [];
  let stillOpen = 0;
  let unreadable = 0;

  for (const r of rows) {
    const who = `#${r.id} ${r.document_type} ${r.application_no ?? `locker/${r.locker_agreement_signing_id ?? r.locker_authorised_user_id ?? '-'}`} ${r.customer ?? ''}`.trim();
    const { status, error } = await statusOf(fetchStatus, isRateLimited, r.digio_request_id);
    if (error) { unreadable++; console.log(`  ?? ${who} — could not read: ${error}`); await sleep(3500); continue; }
    if (isSignedStatus(status)) { signed.push(r); console.log(`  ++ SIGNED   ${who} (Digio: ${status})`); }
    else if (isFailedStatus(status)) { dead.push({ ...r, digio: String(status) }); console.log(`  -- ${String(status).toUpperCase().padEnd(9)} ${who}`); }
    else { stillOpen++; }
    await sleep(3500);
  }

  console.log(`\n[reconcile-digio] Digio's answer: ${signed.length} signed, ${dead.length} dead, ${stillOpen} still open, ${unreadable} unreadable`);
  if (!commit) {
    console.log('[reconcile-digio] dry-run only — re-run with --commit to record these.');
    return;
  }

  // Signatures first: these are the ones that cost the business something.
  for (const r of signed) {
    try {
      const res = await completeSigning(db, r.digio_request_id, {});
      console.log(`  recorded #${r.id} ${r.document_type} ${r.application_no ?? ''} → ok=${res.ok}`);
    } catch (e) {
      // One failure must not abandon the rest — they are all real signatures.
      console.error(`  FAILED  #${r.id} ${r.document_type}: ${(e as Error).message}`);
    }
    await sleep(1000);
  }
  for (const r of dead) {
    try {
      await markSessionFailed(db, r.digio_request_id, r.digio);
      console.log(`  retired #${r.id} ${r.document_type} (${r.digio})`);
    } catch (e) {
      console.error(`  FAILED  #${r.id}: ${(e as Error).message}`);
    }
  }

  const left = (await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM digio_signing_sessions WHERE status = 'requested'")).rows[0]!.n;
  console.log(`[reconcile-digio] done — sessions still 'requested': ${left}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
