/** migrate-legacy/report.ts — render a MigrationReport as a console-friendly
 * reconciliation sheet. Money in ₹ with grouping; no real customer PII printed
 * beyond an application number in the sample. */
import type { MigrationReport } from './pipeline.js';

const inr = (v: number) =>
  '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatReport(r: MigrationReport): string {
  const L: string[] = [];
  const line = (s = '') => L.push(s);
  const pad = (s: string, n: number) => s.padEnd(n);
  const rpad = (s: string, n: number) => s.padStart(n);

  line('═'.repeat(72));
  line('  LEGACY → NEW WEALTH — MIGRATION ' + (r.dryRun ? 'DRY-RUN' : 'COMMIT') + ' REPORT');
  line('═'.repeat(72));
  line(`  Source           : ${r.sourceLabel}`);
  line(`  Interest anchor  : ${r.anchor}  (paid ≤ anchor frozen; > anchor recomputed)`);
  line(`  Mode             : ${r.dryRun ? 'DRY-RUN (rolled back — nothing persisted)' : 'COMMIT'}`);
  line('');

  line('  TABLE LOAD COUNTS');
  line('  ' + pad('table', 26) + rpad('source', 9) + rpad('loaded', 9) + rpad('failed', 9));
  line('  ' + '─'.repeat(53));
  for (const t of r.tables) {
    const flag = t.failed > 0 ? '  ⚠' : '';
    line('  ' + pad(t.table, 26) + rpad(String(t.source), 9) + rpad(String(t.loaded), 9) + rpad(String(t.failed), 9) + flag);
  }
  line('');

  line('  ROLE MAPPING (old → new)');
  for (const m of r.roleMapping) {
    line(`  ${pad(m.oldRole, 20)} → ${pad(m.newRole, 16)}${m.mapped ? '' : '  ⚠ fallback (confirm)'}`);
  }
  line('');

  line('  MONEY RECONCILIATION');
  line(`  Active AUM (source) : ${rpad(inr(r.aum.activeSource), 22)}`);
  line(`  Active AUM (loaded) : ${rpad(inr(r.aum.activeLoaded), 22)}`);
  const aumOk = Math.abs(r.aum.activeSource - r.aum.activeLoaded) < 0.01;
  line(`  Match               : ${aumOk ? '✓ exact' : '✗ MISMATCH — investigate'}`);
  line('');

  line('  INTEREST FREEZE / RECOMPUTE');
  line(`  Frozen rows (≤ anchor)     : ${r.interest.frozenRows}`);
  line(`  Regenerated rows (> anchor): ${r.interest.regeneratedRows}`);
  line(`  Paid rows (source)         : ${r.interest.oldPaidRows}`);
  line(`  Paid rows (loaded)         : ${r.interest.loadedPaidRows}`);
  const paidOk = r.interest.oldPaidRows === r.interest.loadedPaidRows;
  line(`  Paid preserved             : ${paidOk ? '✓ every paid row carried over' : '✗ paid-row count changed — investigate'}`);
  line('');

  if (r.sample) {
    line('  SAMPLE APPLICATION (freeze/recompute proof) — ' + r.sample.applicationNo);
    line('  OLD future rows (> anchor) that were DROPPED:');
    if (!r.sample.oldFuture.length) line('    (none)');
    for (const s of r.sample.oldFuture.slice(0, 6))
      line(`    ${s.due_date}  ${pad(s.due_type, 14)} ${rpad(inr(s.gross), 16)}  [${s.status}]`);
    line('  NEW recomputed rows (> anchor):');
    for (const s of r.sample.newFuture.slice(0, 6))
      line(`    ${s.due_date}  ${pad(s.due_type, 14)} ${rpad(inr(s.gross), 16)}  (${s.period_days}d)`);
    const first = r.sample.newFuture[0];
    if (first) line(`  → first recomputed period = ${first.period_days} days ending ${first.due_date} (expect 30, Jun-29→Jul-28)`);
    line('');
  }

  if (r.anomalies.length) {
    line(`  ANOMALIES (${r.anomalies.length}) — first 20`);
    for (const a of r.anomalies.slice(0, 20)) line('  ⚠ ' + a);
    if (r.anomalies.length > 20) line(`  … and ${r.anomalies.length - 20} more`);
  } else {
    line('  ANOMALIES: none ✓');
  }
  line('═'.repeat(72));
  return L.join('\n');
}
