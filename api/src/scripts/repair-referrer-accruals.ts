/**
 * Re-accrue the investments whose referrer was on the CUSTOMER but not on the
 * investment (owner 2026-09-07: "fix it").
 *
 * Until today the accrual engine read `applications.referred_by_text` alone,
 * while the rest of the system reads
 *   COALESCE(NULLIF(btrim(a.referred_by_text),''), c.referred_by_text)
 * So an investment whose referrer sat on the customer paid the wrong people:
 * the referrer earned nothing, and the enroller was paid the full
 * NO-referrer rate instead of the reduced with-referrer one.
 *
 * Geetha.S is the worked example — referred by agent NAMBI, blank on the
 * investment, ₹70,00,000 paid Rithiesh L staff_new at 2% (₹1,40,000) and NAMBI
 * nothing.
 *
 * WHAT THIS DOES, per affected investment:
 *   1. refuses outright if ANY of its accruals is already PAID — money that has
 *      moved is not silently restated, it is the owner's decision
 *   2. snapshots every existing accrual into audit_log, inside the transaction
 *   3. deletes them and re-runs the real engine (never re-implements the maths)
 *   4. reports who gained and who lost, to the rupee
 *
 *   node dist/scripts/repair-referrer-accruals.js            # dry run
 *   node dist/scripts/repair-referrer-accruals.js --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';

await loadSecretsFromSsm();
const { createDb } = await import('../db/index.js');
const { accrueForApplication } = await import('../modules/incentives/accrual.js');

const COMMIT = process.argv.includes('--commit');
const db = createDb();
const inr = (n: unknown) => '₹' + Number(n ?? 0).toLocaleString('en-IN');

interface Acc { payee_type: string; payee_id: string; payee: string | null; matrix_cell: string | null; amount: string; paid_at: string | null }
const accrualsOf = async (dbx: typeof db, appId: number): Promise<Acc[]> =>
  (await dbx.query<Acc>(
    `SELECT ia.payee_type, ia.payee_id::text, ia.matrix_cell, ia.amount::text, ia.paid_at::text,
            CASE ia.payee_type WHEN 'staff' THEN (SELECT full_name FROM users  WHERE id = ia.payee_id)
                               WHEN 'agent' THEN (SELECT full_name FROM agents WHERE id = ia.payee_id) END AS payee
       FROM incentive_accruals ia WHERE ia.application_id = $1 ORDER BY ia.id`, [appId])).rows;

const show = (label: string, rows: Acc[]) => {
  if (!rows.length) { console.log(`    ${label}: (none)`); return; }
  for (const r of rows) {
    console.log(`    ${label}: ${String(r.payee ?? r.payee_type + '#' + r.payee_id).padEnd(18)} ${String(r.matrix_cell ?? '(none)').padEnd(15)} ${inr(r.amount).padStart(12)}${r.paid_at ? '  [PAID]' : ''}`);
  }
};

// The investments the engine would now answer differently on: the application
// has no referrer of its own but the customer does.
const targets = (await db.query<{ id: string; application_no: string; customer: string; cust_ref: string; total_amount: string }>(
  `SELECT a.id::text, a.application_no, c.full_name AS customer,
          c.referred_by_text AS cust_ref, a.total_amount::text
     FROM applications a JOIN customers c ON c.id = a.customer_id
    WHERE btrim(COALESCE(c.referred_by_text, '')) <> ''
      AND btrim(COALESCE(a.referred_by_text, '')) = ''
      AND a.status NOT IN ('Cancelled', 'Rejected', 'Draft')
    ORDER BY a.application_no`)).rows;

console.log(`${targets.length} investment(s) whose referrer lives on the customer only — ${COMMIT ? 'COMMITTING' : 'DRY RUN'}\n`);
let repaired = 0, refused = 0;

for (const t of targets) {
  const appId = Number(t.id);
  const before = await accrualsOf(db, appId);
  console.log(`${t.application_no}  ${t.customer}  ${inr(t.total_amount)}  referred by "${t.cust_ref}"`);
  show('before', before);

  if (before.some((r) => r.paid_at)) {
    refused++;
    console.log('    REFUSED: an accrual on this investment is already PAID — not restating money that has moved.\n');
    continue;
  }

  try {
    await db.withTx(async (tx) => {
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_data, after_data)
         VALUES (1, 'incentive.referrer-repair', 'applications', $1, $2, $3)`,
        [t.id, JSON.stringify({ accruals: before, app_referred_by: null, customer_referred_by: t.cust_ref }),
         JSON.stringify({ reason: 'Owner 2026-09-07: accrual engine now falls back to the customer referrer, as every other read already did' })]);
      await tx.query('DELETE FROM incentive_accruals WHERE application_id = $1', [appId]);
      await accrueForApplication(tx, appId);
      const after = await accrualsOf(tx as unknown as typeof db, appId);
      show('after ', after);

      const sum = (rows: Acc[]) => rows.reduce((s, r) => s + Number(r.amount), 0);
      console.log(`    total incentive ${inr(sum(before))} -> ${inr(sum(after))}`);
      if (!COMMIT) throw new Error('DRY_RUN');
    });
    repaired++;
    console.log('');
  } catch (e) {
    if (String((e as Error).message) === 'DRY_RUN') { repaired++; console.log(''); continue; }
    console.log(`    FAILED, rolled back: ${(e as Error).message}\n`);
  }
}

console.log(`  repaired : ${repaired}`);
console.log(`  refused  : ${refused}   (already paid — left exactly as they are)`);
console.log(COMMIT ? '\nCOMMITTED.' : '\nDRY RUN — nothing was written. Pass --commit.');
await db.close();
