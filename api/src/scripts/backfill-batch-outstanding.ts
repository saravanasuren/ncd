/**
 * backfill-batch-outstanding — write the remembered outstanding onto payout
 * batches cut before the column existed (owner 2026-09-24).
 *
 * Only the LATEST paid interest batch is ever read by the comparison panel, but
 * every paid batch is filled so a later change of screen cannot resurrect the
 * reconstruction.
 *
 * The figure for a past batch cannot be recovered from the live book — that is
 * the whole problem. It is therefore passed in EXPLICITLY, per batch, and the
 * script refuses to guess:
 *
 *   node dist/scripts/backfill-batch-outstanding.js                     # show
 *   node dist/scripts/backfill-batch-outstanding.js NEFT-2026-000012=694900000 --commit
 *
 * The owner's own figure for the 28-08-2026 batch is ₹69,49,00,000 — the book
 * as it stood that day, which the corrected reconstruction also produces.
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const pairs = new Map<string, number>();
  for (const a of process.argv.slice(2)) {
    const m = /^([A-Za-z0-9-]+)=(\d+(?:\.\d+)?)$/.exec(a);
    if (m) pairs.set(m[1]!, Number(m[2]));
  }
  await loadSecretsFromSsm();
  const db = createDb();

  const { rows } = await db.query<{ id: string; batch_no: string; payout_date: string; status: string; outstanding_at_payout: string | null }>(
    `SELECT id, batch_no, payout_date::text, status, outstanding_at_payout
       FROM payout_batches WHERE kind = 'interest' ORDER BY payout_date DESC, id DESC`);
  console.log(`[backfill-batch-outstanding] ${commit ? 'COMMIT' : 'DRY-RUN'} — ${rows.length} interest batch(es)`);
  for (const r of rows) {
    const want = pairs.get(r.batch_no);
    const held = r.outstanding_at_payout == null ? '(none)' : Number(r.outstanding_at_payout).toLocaleString('en-IN');
    console.log(`  ${r.batch_no}  ${r.payout_date}  ${r.status.padEnd(14)} holds ${held}${want != null ? `  → set ${want.toLocaleString('en-IN')}` : ''}`);
  }
  if (!pairs.size) { console.log('[backfill-batch-outstanding] nothing to set — pass BATCH_NO=amount pairs.'); return; }
  if (!commit) { console.log('[backfill-batch-outstanding] dry-run only — re-run with --commit to apply.'); return; }

  for (const [batchNo, amount] of pairs) {
    // Never overwrite a figure already remembered: a batch cut after the column
    // existed carries the real thing, and a hand-typed number must not replace it.
    const r = await db.query(
      `UPDATE payout_batches SET outstanding_at_payout = $2
        WHERE batch_no = $1 AND kind = 'interest' AND outstanding_at_payout IS NULL`, [batchNo, amount]);
    console.log(r.rowCount ? `  set ${batchNo} = ${amount.toLocaleString('en-IN')}` : `  SKIPPED ${batchNo} — no such interest batch, or it already holds a figure`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
