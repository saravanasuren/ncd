/**
 * ONE-OFF REPAIR — restore the broken-interest rows the wealth import never wrote.
 *
 * Why this exists
 * ---------------
 * The wealth migration brought each redemption across into `redemptions`,
 * `broken_interest` and `broken_tds` included, but it never wrote the matching
 * `disbursement_schedule` row (due_type 'BrokenInterest'). Only the schedule row
 * is payable, and only the schedule row is what the payout summary sheet reads —
 * so for these customers the redemption interest was invisible on the sheet AND
 * would never have been paid.
 *
 * Verified on production 2026-07-24 (read-only) before this was written:
 *   · Paid BrokenInterest history runs through 2026-05 and stops — every row
 *     below is dated after that, so none of them has been settled anywhere.
 *   · Each application has ZERO Paid schedule rows on or after its redemption
 *     date (the one exception, APP-2026-000231, is examined line by line below).
 *   · Each gross reconciles exactly to principal x rate/100 x days/365, so the
 *     figures are wealth's own arithmetic, taken as-is — never recomputed here.
 *
 * NOT a migration. Migrations run on every deploy; this must run once, under a
 * human eye, and it defaults to a dry run.
 *
 *   node ops/restore-legacy-redemption-slices.mjs            # dry run, prints the plan
 *   node ops/restore-legacy-redemption-slices.mjs --write    # actually inserts
 *
 * Run it from the repo ROOT on the production box (~/ncd). It reaches into the
 * API's built output for the app's own SSM config and DB factory, so `npm run
 * build` must have run — which the deploy does.
 * Idempotent: the unique (line_id, due_date, due_type) index plus an explicit
 * pre-check mean a second run inserts nothing.
 */
// Resolved against THIS file, not the shell's cwd, so it works from anywhere.
const api = (p) => new URL(`../api/dist/${p}`, import.meta.url).href;
const { loadSecretsFromSsm } = await import(api('secrets.js'));
process.env.SSM_PARAMETERS_PATH ??= '/dhanam/newwealth/';
process.env.SSM_REGION ??= 'ap-south-1';
await loadSecretsFromSsm();
const { createDb } = await import(api('db/index.js'));

const WRITE = process.argv.includes('--write');

/**
 * The allow-list IS the safety mechanism: nothing outside it can ever be
 * touched, however the query below drifts. Each entry was checked individually.
 *
 * DELIBERATELY EXCLUDED — RED-LEGACY-7, Citycastle Developers (APP-2026-000495,
 * ₹6,575.34). Its redemption row says 1 Apr 2026, but the application has no
 * Premature row and full ₹1,00,000/month interest was Paid on the whole ₹1cr
 * through 28 May 2026. One of those two facts is wrong, and writing a payable
 * row on top of that contradiction would be a guess. Needs a human decision.
 */
const ALLOW = new Set([
  'RED-LEGACY-6',   // J Ananthaprabha       APP-231  18 Jul→ see note
  'RED-LEGACY-8',   // Mohana D              APP-366  29 Jun  1 day
  'RED-LEGACY-9',   // Mohana D              APP-216  29 Jun  1 day
  'RED-LEGACY-10',  // Sakthivel.D           APP-032  29 Jun  1 day
  'RED-LEGACY-11',  // Premalatha Asokan     APP-400  08 Jul 10 days
  'RED-LEGACY-12',  // Jaya Shankari         APP-200  16 Jul 18 days
  'RED-LEGACY-13',  // Balavinod Subramaniam APP-201  16 Jul 18 days
  'RED-LEGACY-14',  // Vasantha Kumar S      APP-419  18 Jul 20 days
]);

// RED-LEGACY-6 (J Ananthaprabha, ₹3,123.29) is the one entry with Paid rows
// after its redemption date, so it was checked by hand: the 28 Jun Interest row
// that was paid is ₹5,095.89 = ₹5,00,000 x 12% x 31/365 — the principal that
// STAYED invested. The ₹5,00,000 that left earned 19 days nobody paid for, which
// is exactly the ₹3,123.29 below. It is owed.

const db = createDb();
const { rows } = await db.query(`
  SELECT r.id AS redemption_id, r.redemption_no, c.full_name, a.application_no,
         a.id AS application_id,
         (SELECT l.id FROM application_lines l WHERE l.application_id = a.id ORDER BY l.id LIMIT 1) AS line_id,
         r.redemption_date::text AS due_date,
         r.broken_interest::numeric AS gross,
         COALESCE(r.broken_tds, 0)::numeric AS tds,
         r.principal::numeric AS principal_basis
    FROM redemptions r
    JOIN applications a ON a.id = r.application_id
    JOIN customers c ON c.id = a.customer_id
   WHERE r.status IN ('Approved','Paid') AND COALESCE(r.broken_interest, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM disbursement_schedule ds
                      WHERE ds.application_id = r.application_id
                        AND ds.due_type = 'BrokenInterest'
                        AND ds.due_date = r.redemption_date)
   ORDER BY r.redemption_date`);

let inserted = 0, skipped = 0, total = 0;
for (const r of rows) {
  if (!ALLOW.has(r.redemption_no)) {
    console.log(`SKIP  ${r.redemption_no.padEnd(15)} ${r.full_name} — not on the allow-list`);
    skipped++;
    continue;
  }
  if (!r.line_id) {
    console.log(`SKIP  ${r.redemption_no.padEnd(15)} ${r.full_name} — no application line`);
    skipped++;
    continue;
  }
  const gross = Number(r.gross), tds = Number(r.tds);
  // net is DERIVED, never rounded on its own — chk_ds_net enforces net = gross − tds.
  const net = Math.round((gross - tds) * 100) / 100;
  total += net;
  console.log(`${WRITE ? 'WRITE' : 'PLAN '} ${r.redemption_no.padEnd(15)} ${String(r.application_no).padEnd(18)} ${r.due_date}  gross ${gross}  tds ${tds}  net ${net}  basis ${r.principal_basis}  ${r.full_name}`);
  if (!WRITE) continue;
  const res = await db.query(
    `INSERT INTO disbursement_schedule
       (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status, principal_basis)
     VALUES ($1,$2,$3::date,'BrokenInterest',$4,$5,$6,'Scheduled',$7)
     ON CONFLICT (line_id, due_date, due_type) DO NOTHING`,
    [Number(r.line_id), Number(r.application_id), r.due_date, gross, tds, net, Number(r.principal_basis)]);
  if (res.rowCount) inserted++;
}

console.log(`\n${WRITE ? 'inserted' : 'would insert'}: ${WRITE ? inserted : rows.length - skipped} row(s), net ₹${total.toFixed(2)} · skipped ${skipped}`);
if (!WRITE) console.log('DRY RUN — nothing was written. Re-run with --write to apply.');
await db.close();
