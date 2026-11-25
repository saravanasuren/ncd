/**
 * align-referrer — make investments agree with their customer's referrer, and
 * move the commission with them.
 *
 *   CODE            the investments adopt whatever the customer record says
 *   CODE=REFERRER   a new referrer is written to the customer AND its investments
 *
 * Dry-run by default; --commit applies.
 *
 *   node dist/scripts/align-referrer.js DHN0532 DHN0533
 *   node dist/scripts/align-referrer.js DHN0534=DHN1204 --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { alignReferrer } from '../modules/incentives/align-referrer.js';

const inr = (v: unknown) => 'Rs ' + Number(v ?? 0).toLocaleString('en-IN');

async function main(): Promise<void> {
  const args = process.argv.filter((a) => /^DHN\w+(=.+)?$/i.test(a))
    .map((a) => { const [code, ...rest] = a.split('='); return { code: code!.toUpperCase(), to: rest.length ? rest.join('=') : null }; });
  const commit = process.argv.includes('--commit');
  if (!args.length) { console.error('Pass CUSTOMERCODE or CUSTOMERCODE=NEW_REFERRER'); process.exit(1); }
  await loadSecretsFromSsm();
  const db = createDb();

  let moved = 0;
  for (const { code, to } of args) {
    const ROLLBACK = Symbol('rollback');
    try {
      await db.withTx(async (tx) => {
        const r = await alignReferrer(tx, code, to);
        console.log(`\n[align] ${r.customer_code} — ${r.customer_name}`);
        console.log(`    referrer "${r.referrer}" -> ${r.resolved_to
          ? `${r.resolved_to.kind} ${r.resolved_to.name}` : 'NOBODY (an agent would be raised)'}`);
        if (r.changed_customer) console.log('    the customer record was updated too');
        for (const a of r.applications) {
          const change = a.was.toLowerCase() === a.now.toLowerCase() ? '(unchanged)' : `"${a.was}" -> "${a.now}"`;
          const who = a.moves
            ? ` [earner moves off ${a.moved_from ? `${a.moved_from.kind} ${a.moved_from.name}` : 'nobody resolvable'}]`
            : ' [same earner]';
          console.log(`    ${a.application_no} ${change}${who}`);
          const show = (label: string, rows: typeof a.before) => rows.length
            ? rows.forEach((x) => console.log(`        ${label}: ${x.payee_type}#${x.payee_id} ${x.matrix_cell ?? '(imported)'} ${inr(x.amount)}`))
            : console.log(`        ${label}: (none)`);
          show('before', a.before);
          show('after ', a.after);
          moved += a.after.reduce((s, x) => s + Number(x.amount), 0);
        }
        if (!commit) throw ROLLBACK;
      });
      if (commit) console.log('    committed.');
    } catch (e) {
      if (e === ROLLBACK) { console.log('    dry-run — rolled back. Re-run with --commit to apply.'); continue; }
      console.error(`    FAILED: ${(e as Error).message}`);
    }
  }
  console.log(`\ncommission now attributed across these customers: ${inr(moved)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
