/**
 * fix-payout-bank-routing — apply the owner's routing rule to the book
 * (2026-09-28): "if a customer has only one debenture and multiple bank account
 * are there - the one marked as active should get the payout interest. if they
 * have multiple debentures and multiple bank accounts - they can assign each to
 * different ones."
 *
 * Does two things, and REFUSES to do a third:
 *
 *   1. Clears the per-investment pin on every customer holding ONE live
 *      debenture, so the active account governs — and so the pin can never
 *      spring back the day a second debenture is opened.
 *   2. Repoints unpaid, unbatched schedule rows onto the account that actually
 *      governs each investment. Paid rows and anything locked into a batch are
 *      never touched: money already sent keeps the account it was sent to.
 *
 *   3. REPORTS ONLY, never moves: investments pinned to an account marked
 *      INACTIVE (owner: "warn, do not move"). An inactive account can still be
 *      the one the customer asked for, so that is a judgement, not a migration.
 *
 *   node dist/scripts/fix-payout-bank-routing.js            # report
 *   node dist/scripts/fix-payout-bank-routing.js --commit   # apply 1 and 2
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';

const LIVE = "a.status IN ('Active','PendingAllotment','PendingActivation','PendingEsign','PendingFundVerification')";

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await loadSecretsFromSsm();
  const db = createDb();
  const money = (n: unknown) => Number(n).toLocaleString('en-IN');

  const single = (await db.query<{ customer_id: string; full_name: string; application_no: string; pinned: string; active: string | null }>(
    `WITH live AS (SELECT a.*, c.full_name FROM applications a JOIN customers c ON c.id = a.customer_id WHERE ${LIVE}),
          cnt  AS (SELECT customer_id, count(*)::int AS n FROM live GROUP BY 1)
     SELECT l.customer_id, l.full_name, l.application_no,
            pb.account_number AS pinned, act.account_number AS active
       FROM live l JOIN cnt ON cnt.customer_id = l.customer_id AND cnt.n = 1
       JOIN customer_bank_accounts pb ON pb.id = l.payout_bank_account_id
       LEFT JOIN customer_bank_accounts act ON act.customer_id = l.customer_id AND act.is_active = TRUE
      ORDER BY l.full_name`)).rows;

  console.log(`[fix-payout-bank-routing] ${commit ? 'COMMIT' : 'REPORT'}`);
  console.log(`\n1. ONE debenture, assignment to clear — the active account governs (${single.length}):`);
  for (const r of single) {
    console.log(`   ${r.full_name} · ${r.application_no}  assigned ${r.pinned}  →  active ${r.active ?? '(none!)'}`);
  }

  const drift = (await db.query<{ n: string; investments: string; customers: string }>(
    `SELECT count(*) AS n, count(DISTINCT a.id) AS investments, count(DISTINCT a.customer_id) AS customers
       FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id
       JOIN LATERAL (
         SELECT cba.account_number, cba.ifsc FROM customer_bank_accounts cba
          WHERE cba.customer_id = a.customer_id
            AND (cba.id = a.payout_bank_account_id
                 OR (a.payout_bank_account_id IS NULL AND cba.is_active = TRUE))
          ORDER BY (cba.id = a.payout_bank_account_id) DESC, cba.id DESC LIMIT 1) b ON TRUE
      WHERE ds.status = 'Scheduled' AND ds.batch_id IS NULL
        AND (ds.payee_account IS DISTINCT FROM b.account_number OR ds.payee_ifsc IS DISTINCT FROM b.ifsc)`)).rows[0]!;
  console.log(`\n2. Unpaid rows pointing at the wrong account: ${drift.n} rows, ${drift.investments} investment(s), ${drift.customers} customer(s)`);

  const inactive = (await db.query<{ full_name: string; application_no: string; amount: string; pinned: string; bank: string; active: string | null }>(
    `SELECT c.full_name, a.application_no, a.total_amount AS amount,
            pb.account_number AS pinned, pb.bank_name AS bank, act.account_number AS active
       FROM applications a JOIN customers c ON c.id = a.customer_id
       JOIN customer_bank_accounts pb ON pb.id = a.payout_bank_account_id AND pb.is_active = FALSE
       LEFT JOIN customer_bank_accounts act ON act.customer_id = a.customer_id AND act.is_active = TRUE
      WHERE ${LIVE} ORDER BY a.total_amount DESC`)).rows;
  console.log(`\n3. ⚠️  Assigned to an INACTIVE account — REPORTED, NOT CHANGED (${inactive.length}):`);
  for (const r of inactive) {
    console.log(`   ${r.full_name} · ${r.application_no} · ₹${money(r.amount)}  pays ${r.pinned} (${r.bank}, inactive)  ·  active is ${r.active ?? '(none)'}`);
  }

  if (!commit) { console.log('\nreport only — re-run with --commit to apply 1 and 2.'); return; }

  const customers = (await db.query<{ id: string }>(
    `SELECT DISTINCT a.customer_id AS id FROM applications a WHERE ${LIVE}`)).rows;
  let cleared = 0, moved = 0;
  const { resnapshotPayeeBank } = await import('../modules/schedule/materialize.js');
  for (const c of customers) {
    await db.withTx(async (tx) => {
      const before = Number((await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM applications a WHERE a.customer_id = $1 AND ${LIVE} AND a.payout_bank_account_id IS NOT NULL`,
        [Number(c.id)])).rows[0]!.n);
      const rows = await resnapshotPayeeBank(tx, Number(c.id));
      const after = Number((await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM applications a WHERE a.customer_id = $1 AND ${LIVE} AND a.payout_bank_account_id IS NOT NULL`,
        [Number(c.id)])).rows[0]!.n);
      cleared += before - after; moved += rows;
    });
  }
  console.log(`\n[fix-payout-bank-routing] done — ${cleared} assignment(s) cleared, ${moved} unpaid row(s) repointed.`);
  console.log(`The ${inactive.length} assigned to an inactive account were left alone, as asked.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
