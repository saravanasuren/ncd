/**
 * fix-stale-referrer-row — an UNPAID commission row on somebody the referrer
 * does not name is either removed (the right earner already has it) or moved
 * onto the right earner. The amount is never recomputed; a PAID row is never
 * touched. See ../modules/incentives/stale-referrer-row.ts for why re-accruing
 * is the wrong tool here.
 *
 *   node dist/scripts/fix-stale-referrer-row.js APP-2026-000619 --reason="..."
 *   node dist/scripts/fix-stale-referrer-row.js APP-2026-000619 APP-2026-000596 --reason="..." --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { fixStaleReferrerRows } from '../modules/incentives/stale-referrer-row.js';

const inr = (v: unknown) => 'Rs ' + Number(v ?? 0).toLocaleString('en-IN');

async function main(): Promise<void> {
  const apps = process.argv.filter((a) => /^APP-\d{4}-\d+$/i.test(a)).map((a) => a.toUpperCase());
  const commit = process.argv.includes('--commit');
  const reason = (process.argv.find((a) => a.startsWith('--reason='))?.slice('--reason='.length) ?? '').trim();
  if (!apps.length) { console.error('Pass one or more application numbers, e.g. APP-2026-000619'); process.exit(1); }
  if (!reason) { console.error('--reason="..." is required; it goes into the audit row.'); process.exit(1); }

  await loadSecretsFromSsm();
  const db = createDb();
  let moved = 0, removed = 0;

  for (const no of apps) {
    const ROLLBACK = Symbol('rollback');
    try {
      await db.withTx(async (tx) => {
        const acts = await fixStaleReferrerRows(tx, no, { reason });
        console.log(`\n[${no}]`);
        if (!acts.length) { console.log('    nothing stale — every unpaid row already sits on the named referrer.'); }
        for (const a of acts) {
          console.log(`    referrer "${a.referrer_text}" -> ${a.should_be.kind} ${a.should_be.name}`);
          if (a.action === 'deleted') {
            removed += a.amount;
            console.log(`    DELETED a duplicate: ${a.from.kind}#${a.from.id} ${a.from.name ?? ''} ${inr(a.amount)}`);
            console.log(`      ${a.should_be.name} already holds this investment's commission${a.alongside_paid ? ' and has been PAID it' : ''}.`);
          } else {
            moved += a.amount;
            console.log(`    MOVED ${inr(a.amount)}: ${a.from.kind}#${a.from.id} ${a.from.name ?? ''} -> ${a.should_be.kind}#${a.should_be.id} ${a.should_be.name}`);
            console.log('      amount unchanged — the import had the figure right and the name wrong.');
          }
        }
        if (!commit) throw ROLLBACK;
      });
      if (commit) console.log('    committed.');
    } catch (e) {
      if (e === ROLLBACK) { console.log('    dry-run — rolled back. Re-run with --commit to apply.'); continue; }
      console.error(`    FAILED: ${(e as Error).message}`);
    }
  }

  console.log(`\nduplicate commission removed: ${inr(removed)}`);
  console.log(`commission moved to the named referrer: ${inr(moved)}`);
  if (!commit) console.log('\nDRY RUN — nothing was written.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
