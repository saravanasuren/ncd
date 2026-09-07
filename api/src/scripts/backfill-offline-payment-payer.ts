/**
 * Put the tenant's name on the locker-rent approvals already waiting (owner
 * 2026-09-07: "im not knowing whose locker rent has been given for approval").
 *
 * The card resolves the name from the request metadata, which only exists on
 * payments recorded after that change. The ones already in the queue have none —
 * and cannot get one from our own tables: measured on production, every locker
 * with a pending payment is absent from EVERY NCD locker table. LockerHub is the
 * only source, so this asks them once per request and writes the answer onto the
 * request.
 *
 *   node dist/scripts/backfill-offline-payment-payer.js            # dry run
 *   node dist/scripts/backfill-offline-payment-payer.js --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';

await loadSecretsFromSsm();
const { createDb } = await import('../db/index.js');
const { resolvePayer } = await import('../modules/lockers/offlinePayments.js');

const COMMIT = process.argv.includes('--commit');
const db = createDb();

const reqs = (await db.query<{ id: string; request_no: string; metadata: Record<string, unknown> }>(
  `SELECT id, request_no, metadata FROM approval_requests
    WHERE request_type = 'locker_offline_payment' AND status = 'Pending'
      AND (metadata->>'tenant_name') IS NULL
    ORDER BY id`)).rows;

console.log(`${reqs.length} pending locker-rent approval(s) with no name — ${COMMIT ? 'COMMITTING' : 'DRY RUN'}\n`);
let named = 0, unknown = 0;

for (const r of reqs) {
  const appId = String(r.metadata?.lockerhub_application_id ?? '');
  if (!appId) { unknown++; console.log(`  ${r.request_no}  — no locker application on the request, skipped`); continue; }
  const who = await resolvePayer(db, appId);
  if (!who.tenant_name) {
    unknown++;
    console.log(`  ${r.request_no}  ${appId} — LockerHub could not name the tenant, left as is`);
    continue;
  }
  if (COMMIT) {
    await db.query(
      `UPDATE approval_requests
          SET metadata = metadata
            || jsonb_build_object('tenant_name', $2::text)
            || CASE WHEN $3::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('locker_no', $3::text) END
            || CASE WHEN $4::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('branch_name', $4::text) END
            || CASE WHEN $5::int  IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('customer_id', $5::int) END
            || CASE WHEN $6::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('customer_code', $6::text) END,
              updated_at = now()
        WHERE id = $1`,
      [Number(r.id), who.tenant_name, who.locker_no, who.branch_name, who.customer_id, who.customer_code]);
  }
  named++;
  console.log(`  ${r.request_no}  ${appId} → ${who.tenant_name}${who.locker_no ? ` · Locker ${who.locker_no}` : ''}${who.customer_code ? ` (${who.customer_code})` : ' [not an NCD customer]'}`);
}

console.log(`\n  named   : ${named}`);
console.log(`  unknown : ${unknown}   (left as they are)`);
console.log(COMMIT ? '\nCOMMITTED.' : '\nDRY RUN — nothing written. Pass --commit.');
await db.close();
