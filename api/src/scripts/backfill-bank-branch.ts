/**
 * backfill-bank-branch — fill the bank name and branch that were never stored.
 *
 * Two separate causes left 475 accounts short (2026-09-16):
 *
 *   · the wealth import (18 Jul 2026) carried the bank name and NOT the branch —
 *     402 accounts, every one stamped the same second;
 *   · the enrolment console fills both from an IFSC lookup in the BROWSER, and
 *     only if that lookup beat the save. 74 accounts went in with both blank,
 *     17 of them in Sep 2026 alone.
 *
 * Either way the IFSC was stored, and the IFSC is enough: every code sampled
 * from the affected rows resolved against the directory. So this reads each
 * account's own IFSC and fills ONLY the fields that are empty.
 *
 * It never overwrites a value that is already there — a branch somebody typed
 * by hand beats the directory, and a bank that has since been renamed should not
 * be silently restated under a customer who was paid under the old name.
 *
 * Safe to re-run: a row with nothing left to fill is skipped, and a code the
 * directory cannot resolve is reported and left alone rather than blanked.
 *
 * DRY-RUN (default): shows exactly what each row would become; writes nothing.
 * COMMIT (--commit): applies it, one UPDATE per account.
 *
 *   unset DATABASE_URL LEGACY_DATABASE_URL
 *   node dist/scripts/backfill-bank-branch.js            # dry-run
 *   node dist/scripts/backfill-bank-branch.js --commit   # apply
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';
import { lookupIfsc } from '../integrations/ifsc.js';

interface Row {
  id: string; customer_code: string | null; account_number: string; ifsc: string;
  bank_name: string | null; branch_name: string | null; branch_city: string | null;
}
const blank = (v: unknown) => String(v ?? '').trim() === '';

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await loadSecretsFromSsm();
  const db = createDb();

  const { rows } = await db.query<Row>(
    `SELECT b.id, c.customer_code, b.account_number, b.ifsc, b.bank_name, b.branch_name, b.branch_city
       FROM customer_bank_accounts b
       LEFT JOIN customers c ON c.id = b.customer_id
      WHERE btrim(coalesce(b.ifsc,'')) <> ''
        AND (btrim(coalesce(b.bank_name,''))   = ''
          OR btrim(coalesce(b.branch_name,'')) = ''
          OR btrim(coalesce(b.branch_city,'')) = '')
      ORDER BY b.id`);

  console.log(`[backfill-bank-branch] ${commit ? 'COMMIT' : 'DRY-RUN'} — ${rows.length} account(s) with something missing`);

  // One directory call per DISTINCT code, not per account: many customers share
  // a branch, and the directory is a courtesy we should not hammer.
  const seen = new Map<string, Awaited<ReturnType<typeof lookupIfsc>>>();
  const planned: Array<{ id: string; who: string; ifsc: string; sets: string[]; bank: string | null; branch: string | null; city: string | null }> = [];
  const unresolved: string[] = [];

  for (const r of rows) {
    if (!seen.has(r.ifsc)) seen.set(r.ifsc, await lookupIfsc(r.ifsc));
    const info = seen.get(r.ifsc);
    if (!info) { if (!unresolved.includes(r.ifsc)) unresolved.push(r.ifsc); continue; }
    const bank   = blank(r.bank_name)   && info.bank   ? info.bank   : null;
    const branch = blank(r.branch_name) && info.branch ? info.branch : null;
    const city   = blank(r.branch_city) && info.city   ? info.city   : null;
    const sets = [bank && 'bank_name', branch && 'branch_name', city && 'branch_city'].filter(Boolean) as string[];
    if (!sets.length) continue;   // nothing the directory can add
    planned.push({ id: r.id, who: `${r.customer_code ?? '—'} ${r.account_number}`, ifsc: r.ifsc, sets, bank, branch, city });
  }

  console.log(`[backfill-bank-branch] ${planned.length} row(s) to fill · ${seen.size} distinct IFSC looked up · ${unresolved.length} code(s) the directory could not resolve`);
  if (unresolved.length) console.log('  unresolved (left untouched):', unresolved.join(', '));
  for (const p of planned.slice(0, 20)) {
    console.log(`  ${p.who}  ${p.ifsc}  →  ${p.sets.join(', ')}  |  ${[p.bank, p.branch, p.city].filter(Boolean).join(' · ')}`);
  }
  if (planned.length > 20) console.log(`  … and ${planned.length - 20} more`);

  if (!commit) { console.log('[backfill-bank-branch] dry-run only — re-run with --commit to apply.'); return; }

  let done = 0;
  for (const p of planned) {
    // COALESCE on the column, not the new value: if anything filled this row in
    // between the read and the write, what is there already wins.
    await db.query(
      `UPDATE customer_bank_accounts
          SET bank_name   = COALESCE(NULLIF(btrim(coalesce(bank_name,'')),   ''), $2),
              branch_name = COALESCE(NULLIF(btrim(coalesce(branch_name,'')), ''), $3),
              branch_city = COALESCE(NULLIF(btrim(coalesce(branch_city,'')), ''), $4)
        WHERE id = $1`, [p.id, p.bank, p.branch, p.city]);
    done++;
  }
  console.log(`[backfill-bank-branch] done — ${done} account(s) updated.`);

  const left = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM customer_bank_accounts
      WHERE btrim(coalesce(ifsc,'')) <> ''
        AND (btrim(coalesce(bank_name,'')) = '' OR btrim(coalesce(branch_name,'')) = '')`)).rows[0]!.n;
  console.log(`[backfill-bank-branch] still missing a bank or branch: ${left}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
