/**
 * DC/2026/SD/00001 — the Debenture 1-5 certificate number (owner 2026-11-16).
 *
 * One number per holding, printed on BOTH renderings. Asked whether the two
 * forms should carry separate runs, the owner said "rename both as -
 * DC/2026/SD/00001", so the rule #513 was built around still holds: one
 * holding can never look like two instruments.
 *
 * The run restarts each January. The template cannot do that on its own —
 * {yyyy} only prints a year — so the COUNTER is year-scoped, and that is the
 * part worth testing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractText } from './helpers/pdf-text.js';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let admin: Client, checker: Client, schemeId: number;

function migrationSql(): string {
  const sql = readFileSync(
    fileURLToPath(new URL('../src/db/migrations/115_debenture_certificate_numbers.sql', import.meta.url)), 'utf8');
  // Keep the DDL out — the column already exists once migrations have run.
  const body = sql.slice(sql.indexOf('DO $$'));
  return body.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').trim();
}
const runMigration = () => ctx.db.query(migrationSql());

beforeAll(async () => {
  ctx = await startTestServer();
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
});
afterAll(async () => { await ctx.close(); });

const squash = (s: string) => s.replace(/\s+/g, '');
let tag = 0;

async function debSeries(close: string) {
  const code = `DEB-N${++tag}`;
  const id = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ($1,$1,'Open',100000,TRUE,$2::date,$2::date) RETURNING id`, [code, close])).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2)', [id, schemeId]);
  return id;
}

async function holding(seriesId: number, name: string, phone: string, moneyOn = '2026-10-05') {
  const cust = await admin.post('/api/customers', { full_name: name, phone });
  if (cust.status !== 201) throw new Error(`customer ${phone}: ${cust.status} ${JSON.stringify(cust.json)}`);
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: Number(cust.json.id),
    series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: moneyOn,
  });
  await approveInvestment(checker, app);
  return Number(cust.json.id);
}

const serialOf = async (cid: number, sid: number) => (await ctx.db.query<{ s: string; p: string | null }>(
  'SELECT bond_serial_no AS s, previous_bond_serial_no AS p FROM consolidated_bonds WHERE customer_id = $1 AND series_id = $2',
  [cid, sid])).rows[0]!;

describe('the Debenture certificate number', () => {
  it('is minted as DC/{year}/SD/#####, five digits from 00001', async () => {
    const sid = await debSeries('2026-10-31');
    const cid = await holding(sid, 'First Number', '9555110001');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await consolidatedBondCertificatePdf(ctx.db, cid, sid);
    expect((await serialOf(cid, sid)).s).toMatch(/^DC\/2026\/SD\/\d{5}$/);
  });

  it('prints the SAME number on both forms', async () => {
    // The rule #513 exists for: one holding, one instrument, two renderings.
    const sid = await debSeries('2026-10-31');
    const cid = await holding(sid, 'Both Forms', '9555110002');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const sub = squash(extractText(await consolidatedBondCertificatePdf(ctx.db, cid, sid)));
    const ncd = squash(extractText(await consolidatedBondCertificatePdf(ctx.db, cid, sid, 'debenture')));
    const { s } = await serialOf(cid, sid);

    expect(sub).toContain(squash(s));
    expect(ncd).toContain(squash(s));
    // And only ever one row for the holding.
    expect(Number((await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM consolidated_bonds WHERE customer_id = $1 AND series_id = $2',
      [cid, sid])).rows[0]!.n)).toBe(1);
  });

  it('never hands the same number to two holdings', async () => {
    const sid = await debSeries('2026-10-31');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const cid = await holding(sid, `Unique ${['One', 'Two', 'Three', 'Four'][i]}`, `95551200${10 + i}`);
      await consolidatedBondCertificatePdf(ctx.db, cid, sid);
      const { s } = await serialOf(cid, sid);
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
    expect(seen.size).toBe(4);
  });

  it('is permanent — downloading again never re-mints it', async () => {
    const sid = await debSeries('2026-10-31');
    const cid = await holding(sid, 'Stays Put', '9555110003');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await consolidatedBondCertificatePdf(ctx.db, cid, sid);
    const first = (await serialOf(cid, sid)).s;
    await consolidatedBondCertificatePdf(ctx.db, cid, sid, 'debenture');
    await consolidatedBondCertificatePdf(ctx.db, cid, sid);
    expect((await serialOf(cid, sid)).s).toBe(first);
  });

  it('restarts the run in a new year', async () => {
    // A single counter would have continued straight on into January. The
    // counter is keyed per year, so each year opens at 00001.
    const s2027 = await debSeries('2027-01-31');
    const cid = await holding(s2027, 'New Year', '9555110004', '2027-01-05');
    await ctx.db.query(
      `UPDATE applications SET allotment_date = '2027-01-31' WHERE customer_id = $1 AND series_id = $2`, [cid, s2027]);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await consolidatedBondCertificatePdf(ctx.db, cid, s2027);
    expect((await serialOf(cid, s2027)).s).toBe('DC/2027/SD/00001');
  });
});

describe('renumbering what was already issued', () => {
  // The migration numbers from 00001, which is only safe on a database with no
  // DC numbers yet — true in production, not true here after the tests above.
  beforeEach(async () => { await ctx.db.query('DELETE FROM consolidated_bonds'); });

  it('moves SD- numbers into the DC run, ordered by date of the holding', async () => {
    // The owner's choice: the money that came in first takes 00001, whichever
    // certificate happened to be printed first. So the OLDEST holding here is
    // given the HIGHEST old number, and must still come out 00001.
    const sid = await debSeries('2026-10-31');
    const early = await holding(sid, 'Money First', '9555110010', '2026-10-02');
    const late = await holding(sid, 'Money Later', '9555110011', '2026-10-20');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await consolidatedBondCertificatePdf(ctx.db, late, sid);
    await consolidatedBondCertificatePdf(ctx.db, early, sid);
    await ctx.db.query(
      `UPDATE consolidated_bonds SET bond_serial_no = 'SD-2026-0001', previous_bond_serial_no = NULL
        WHERE customer_id = $1 AND series_id = $2`, [late, sid]);
    await ctx.db.query(
      `UPDATE consolidated_bonds SET bond_serial_no = 'SD-2026-0002', previous_bond_serial_no = NULL
        WHERE customer_id = $1 AND series_id = $2`, [early, sid]);

    await runMigration();

    expect((await serialOf(early, sid)).s).toBe('DC/2026/SD/00001');
    expect((await serialOf(late, sid)).s).toBe('DC/2026/SD/00002');
  });

  it('keeps the number that is printed on the paper', async () => {
    // The owner accepted that a certificate already handed out shows a number
    // the system no longer carries. Keeping the old one is what lets a holder
    // quoting it still be found.
    const sid = await debSeries('2026-10-31');
    const cid = await holding(sid, 'Old Number Kept', '9555110012', '2026-10-07');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await consolidatedBondCertificatePdf(ctx.db, cid, sid);
    await ctx.db.query(
      `UPDATE consolidated_bonds SET bond_serial_no = 'SD-2026-0096', previous_bond_serial_no = NULL
        WHERE customer_id = $1 AND series_id = $2`, [cid, sid]);

    await runMigration();

    const row = await serialOf(cid, sid);
    expect(row.s).toMatch(/^DC\/2026\/SD\/\d{5}$/);
    expect(row.p).toBe('SD-2026-0096');
    // And it is findable by the old number.
    const found = (await ctx.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM consolidated_bonds WHERE previous_bond_serial_no = 'SD-2026-0096'")).rows[0]!.n;
    expect(Number(found)).toBe(1);
  });

  it('leaves the counter past the numbers it just issued', async () => {
    // The failure this guards is one we have already had once: a repair that
    // moves numbers without moving the counter, so the next mint collides.
    const sid = await debSeries('2026-10-31');
    const cid = await holding(sid, 'Counter Moves', '9555110013', '2026-10-08');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await consolidatedBondCertificatePdf(ctx.db, cid, sid);
    await ctx.db.query(
      `UPDATE consolidated_bonds SET bond_serial_no = 'SD-2026-0500', previous_bond_serial_no = NULL
        WHERE customer_id = $1 AND series_id = $2`, [cid, sid]);

    await runMigration();
    const renumbered = (await serialOf(cid, sid)).s;

    // The very next certificate must not be handed the number just issued.
    const next = await holding(sid, 'Next After Renumber', '9555110014', '2026-10-09');
    await consolidatedBondCertificatePdf(ctx.db, next, sid);
    expect((await serialOf(next, sid)).s).not.toBe(renumbered);
  });

  it('is safe to run twice', async () => {
    const sid = await debSeries('2026-10-31');
    const cid = await holding(sid, 'Twice Over', '9555110015', '2026-10-10');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await consolidatedBondCertificatePdf(ctx.db, cid, sid);
    await ctx.db.query(
      `UPDATE consolidated_bonds SET bond_serial_no = 'SD-2026-0777', previous_bond_serial_no = NULL
        WHERE customer_id = $1 AND series_id = $2`, [cid, sid]);

    await runMigration();
    const once = (await serialOf(cid, sid)).s;
    await expect(runMigration()).resolves.toBeDefined();
    expect((await serialOf(cid, sid)).s).toBe(once);
  });
});
