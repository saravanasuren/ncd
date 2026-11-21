/**
 * Locker Master Report.
 *
 * Two promises are worth guarding. It must not disagree with the Locker Rent
 * Report about rent — they drifted once before, which is why rentStatus.ts
 * exists — and a locker with NO signing row must read "Not started" rather than
 * blank, because ~63 allotted lockers genuinely have no signed agreement and a
 * blank cell reads as "didn't load".
 *
 * LockerHub is not configured under test, so the occupied side is built from
 * the local exception tables and the vacant side is reported unavailable. That
 * is the degraded path, and it is the one most likely to be hit in the branch
 * on a bad morning — so it is the one pinned here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { lockerMasterReport } from '../src/modules/lockers/masterReport.js';
import { buildLockerMasterBook } from '../src/modules/lockers/masterReportXlsx.js';
import { lockerRentReport } from '../src/modules/lockers/report.js';
import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';

let ctx: TestCtx;
const APP = 'LH-MASTER-1';
const APP2 = 'LH-MASTER-2';
let customerId = 0;

const as = async (email: string, password = 'Demo_1234') => {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email, password });
  return c;
};

beforeAll(async () => {
  ctx = await startTestServer();

  customerId = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO customers (full_name, customer_code, phone)
     VALUES ('Locker Holder One', 'DHN7701', '9000000011') RETURNING id`)).rows[0]!.id);

  // Two lockers NCD knows about. The rent report picks applications up from the
  // waiver / deposit-link / cheque tables, so a fee waiver is what puts them in.
  for (const [id, locker] of [[APP, 'A-101'], [APP2, 'A-102']] as const) {
    await ctx.db.query(
      `INSERT INTO locker_applications (lockerhub_application_id, customer_id, customer_name, phone,
         branch_id, branch_name, locker_size, locker_number, agreement_no)
       VALUES ($1, $2, 'Locker Holder One', '9000000011', 'BR1', 'Coimbatore Main', 'Medium', $3, $4)`,
      [id, customerId, locker, id === APP ? 'DIF0101' : null]);
    await ctx.db.query(
      `INSERT INTO locker_fee_waivers (lockerhub_application_id, leg, waiver_pct, reason, status)
       VALUES ($1, 'rent', 100, 'test fixture', 'Approved')`, [id]);
    await ctx.db.query(
      `INSERT INTO locker_allotments (lockerhub_application_id, customer_id, locker_no, branch_id,
         branch_name, allotted_on, backdated)
       VALUES ($1, $2, $3, 'BR1', 'Coimbatore Main', DATE '2026-03-15', FALSE)`,
      [id, customerId, locker]);
  }

  // Only the FIRST locker has a signed agreement.
  await ctx.db.query(
    `INSERT INTO locker_agreement_signings (lockerhub_application_id, customer_id, method, status, signed_on)
     VALUES ($1, $2, 'physical', 'Signed', DATE '2026-03-20')`, [APP, customerId]);

  // A joint hirer and an authorised user on the first; a revoked one that must
  // NOT be listed.
  await ctx.db.query(
    `INSERT INTO locker_application_hirers (lockerhub_application_id, position, full_name)
     VALUES ($1, 2, 'Second Hirer')`, [APP]);
  await ctx.db.query(
    `INSERT INTO locker_authorised_users (lockerhub_application_id, customer_id, name, status)
     VALUES ($1, $2, 'Active Agent', 'active'), ($1, $2, 'Gone Away', 'revoked')`, [APP, customerId]);
});
afterAll(async () => { await ctx.close(); });

describe('the master report', () => {
  it('lists the lockers NCD knows about', async () => {
    const rep = await lockerMasterReport(ctx.db);
    const lockers = rep.rows.map((r) => r.locker_no);
    expect(lockers).toContain('A-101');
    expect(lockers).toContain('A-102');
    expect(rep.totals.occupied).toBeGreaterThanOrEqual(2);
  });

  it('cannot disagree with the rent report about rent', async () => {
    // The whole reason the master report is built ON the rent report.
    const [master, rent] = await Promise.all([lockerMasterReport(ctx.db), lockerRentReport(ctx.db)]);
    const byId = new Map(master.rows
      .filter((r) => r.lockerhub_application_id)
      .map((r) => [r.lockerhub_application_id!, r]));
    expect(rent.rows.length).toBeGreaterThan(0);
    for (const r of rent.rows) {
      const m = byId.get(r.lockerhub_application_id);
      expect(m, `${r.lockerhub_application_id} should be in the master report`).toBeTruthy();
      expect(m!.rent_status).toBe(r.rent_status);
      expect(m!.rent_amount).toBe(r.rent_amount);
      // The master report may FILL IN a locker number the rent report left
      // blank — it falls back to our own record when LockerHub is unreachable —
      // but where the rent report names one, the two must agree.
      if (r.locker_no) expect(m!.locker_no).toBe(r.locker_no);
    }
  });

  it('names the locker AND the hirer from our own record when LockerHub is silent', async () => {
    // LockerHub is unconfigured here, so the rent report has neither — it reads
    // the locker off their application and finds the customer by matching that
    // application's phone. A master report that can name neither the locker nor
    // who holds it is of no use in a branch.
    const rent = await lockerRentReport(ctx.db);
    expect(rent.rows.every((r) => r.locker_no === null), 'precondition: LockerHub is silent').toBe(true);
    expect(rent.rows.every((r) => r.customer_name === null), 'precondition: no hirer resolved').toBe(true);

    const rep = await lockerMasterReport(ctx.db);
    const row = rep.rows.find((r) => r.lockerhub_application_id === APP)!;
    expect(row.locker_no).toBe('A-101');
    expect(row.branch).toBe('Coimbatore Main');
    expect(row.size).toBe('Medium');
    expect(row.customer_name).toBe('Locker Holder One');
    expect(row.customer_code).toBe('DHN7701');
    expect(row.phone).toBe('9000000011');
  });

  it('refuses to claim an occupancy % when the vacant side was not counted', async () => {
    // occupied ÷ (occupied + 0) is 100%, which would report every cabinet full
    // on the morning LockerHub is down. A dash is the honest answer.
    const rep = await lockerMasterReport(ctx.db);
    expect(rep.vacant_unavailable).toBe(true);
    expect(rep.totals.occupancy_pct).toBeNull();
    expect(rep.branches.every((b) => b.occupancy_pct === null)).toBe(true);
  });

  it('says "Not started" for a locker with no signing row, never blank', async () => {
    const rep = await lockerMasterReport(ctx.db);
    const signed = rep.rows.find((r) => r.lockerhub_application_id === APP);
    const unsigned = rep.rows.find((r) => r.lockerhub_application_id === APP2);
    expect(signed!.agreement_status).toBe('Signed');
    expect(signed!.signed_on).toBe('2026-03-20');
    expect(signed!.agreement_method).toBe('physical');
    expect(unsigned!.agreement_status).toBe('Not started');
    expect(unsigned!.signed_on).toBeNull();
  });

  it('counts the unsigned agreements, because that is the finding', async () => {
    const rep = await lockerMasterReport(ctx.db);
    expect(rep.totals.agreement_signed).toBeGreaterThanOrEqual(1);
    expect(rep.totals.agreement_missing).toBeGreaterThanOrEqual(1);
    expect(rep.totals.agreement_signed + rep.totals.agreement_missing).toBe(rep.totals.occupied);
  });

  it('carries the allotment date and the agreement number', async () => {
    const rep = await lockerMasterReport(ctx.db);
    const row = rep.rows.find((r) => r.lockerhub_application_id === APP)!;
    expect(row.allotted_on).toBe('2026-03-15');
    expect(row.backdated).toBe(false);
    expect(row.agreement_no).toBe('DIF0101');
  });

  it('lists joint hirers and ACTIVE authorised users only', async () => {
    const rep = await lockerMasterReport(ctx.db);
    const row = rep.rows.find((r) => r.lockerhub_application_id === APP)!;
    expect(row.joint_hirers).toContain('Second Hirer');
    expect(row.authorised_users).toContain('Active Agent');
    // A revoked consent is not somebody who may open the locker.
    expect(row.authorised_users ?? '').not.toContain('Gone Away');
  });

  it('summarises by branch, and the branch totals add up', async () => {
    const rep = await lockerMasterReport(ctx.db);
    const sum = rep.branches.reduce((s, b) => s + b.total, 0);
    expect(sum).toBe(rep.totals.lockers);
    expect(rep.branches.every((b) => b.occupied + b.vacant === b.total)).toBe(true);
  });

  it('flags that vacant lockers could not be read rather than reporting zero free', async () => {
    // LockerHub is not configured under test. "0 vacant" would be a lie that
    // reads like a full cabinet; the flag is what stops that.
    const rep = await lockerMasterReport(ctx.db);
    expect(rep.vacant_unavailable).toBe(true);
  });
});

describe('the Excel book', () => {
  it('has the six tabs, and they open', async () => {
    const rep = await lockerMasterReport(ctx.db);
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((res) => sink.on('end', () => res()));
    await buildLockerMasterBook(sink, rep);
    sink.end();
    await done;

    const buf = Buffer.concat(chunks);
    expect(buf.length).toBeGreaterThan(1000);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Locker Summary', 'Master Lockers', 'Hirers', 'Agreements', 'Rent & Deposit', 'Vacant',
    ]);
    // The master tab carries a row per locker plus header and total.
    const master = wb.getWorksheet('Master Lockers')!;
    expect(master.rowCount).toBeGreaterThanOrEqual(rep.rows.length + 1);
  });

  it('prints rent in the shared vocabulary, not the raw code', async () => {
    const rep = await lockerMasterReport(ctx.db);
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((res) => sink.on('end', () => res()));
    await buildLockerMasterBook(sink, rep);
    sink.end();
    await done;

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Master Lockers')!;
    const seen = new Set<string>();
    ws.eachRow((row, n) => { if (n > 1) seen.add(String(row.getCell(11).value ?? '')); });
    // "Waived", never "waived".
    for (const v of seen) expect(v).not.toMatch(/^(paid|waived|premium|unpaid|unknown)$/);
  });
});

describe('the routes', () => {
  it('need a signed-in user who can work lockers', async () => {
    const anon = new Client(ctx.base);
    expect((await anon.get('/api/lockers/master-report')).status).toBe(401);
    const agent = await as('agent@demo.local');
    expect((await agent.get('/api/lockers/master-report')).status).toBe(403);
  });

  it('serves the report and the workbook', async () => {
    const ncd = await as('ncd@demo.local');
    const json = await ncd.get('/api/lockers/master-report');
    expect(json.status).toBe(200);
    expect(Array.isArray(json.json.rows)).toBe(true);
    expect(json.json.totals.lockers).toBeGreaterThanOrEqual(2);

    const xlsx = await ncd.raw('/api/lockers/master-report.xlsx');
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml');
    expect(xlsx.headers.get('content-disposition')).toContain('locker-master-report.xlsx');
    expect(xlsx.buffer.length).toBeGreaterThan(1000);
  });
});
