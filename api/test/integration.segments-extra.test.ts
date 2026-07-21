/**
 * Segments additions (owner rules 2026-07-21):
 *  - Branch-wise / Locker Hub / Dhanamfin tabs.
 *  - Redeemed investments show as children in a series expansion (but do NOT
 *    inflate the outstanding/investors summary).
 *  - Locker-deposit drill carries the customer's branch.
 *  - Universal search finds an application by its number.
 * Seeds directly so it is independent of the investment HTTP flow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}

describe('segments — branch / channel tabs, redeemed children, search', () => {
  beforeAll(async () => {
    const db = ctx.db;
    const branch = Number((await db.query("INSERT INTO branches (code, name) VALUES ('SEGBR','Seg Test Branch') RETURNING id")).rows[0]!.id);
    const series = Number((await db.query("INSERT INTO series (code, name, status, opened_at, allotted_at) VALUES ('NCD-SEG','Seg Series','Allotted','2026-06-01','2026-07-15') RETURNING id")).rows[0]!.id);
    const c1 = Number((await db.query("INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active, branch_id) VALUES ('SEGC1','Seg One','9700000001','Approved',TRUE,$1) RETURNING id", [branch])).rows[0]!.id);
    const c2 = Number((await db.query("INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active, branch_id) VALUES ('SEGC2','Seg Two','9700000002','Approved',TRUE,$1) RETURNING id", [branch])).rows[0]!.id);
    const mkApp = async (no: string, cid: number, status: string, amt: number, source: string, locker = false, dmr: string | null = null) =>
      db.query(
        "INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, source, is_locker_deposit, date_money_received, allotment_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'2026-07-15')",
        [no, cid, series, status, amt, source, locker, dmr]);
    await mkApp('APP-SEG-1', c1, 'Active', 500000, 'lockerhub', false, '2026-07-06');   // active, lockerhub
    await mkApp('APP-SEG-2', c2, 'Redeemed', 300000, 'dhanamfin', false, '2026-07-01');  // redeemed, dhanamfin
    await mkApp('APP-SEG-3', c1, 'Active', 200000, 'dhanamfin', true, '2026-07-05');      // active locker deposit, dhanamfin
  });

  it('Branch-wise groups by branch; outstanding counts only live money', async () => {
    const a = await admin();
    const r = await a.get('/api/reports/segments/branch');
    const g = r.json.groups.find((x: any) => x.key === 'Seg Test Branch');
    expect(g).toBeTruthy();
    expect(Number(g.outstanding)).toBe(700000);   // APP-SEG-1 + APP-SEG-3 (not the redeemed APP-SEG-2)
    expect(g.investors).toBe(1);                   // only c1 has live money; c2 fully redeemed
    // the redeemed investment is still visible as a child
    expect(g.children.some((c: any) => c.application_no === 'APP-SEG-2' && c.status === 'Redeemed')).toBe(true);
  });

  it('Series expansion lists redeemed customers too', async () => {
    const a = await admin();
    const r = await a.get('/api/reports/segments/series');
    const g = r.json.groups.find((x: any) => x.key === 'NCD-SEG');
    expect(g).toBeTruthy();
    expect(Number(g.outstanding)).toBe(700000);                       // active only
    expect(Number(g.redeemed)).toBe(300000);                          // register redeemed column
    expect(g.children.some((c: any) => c.status === 'Redeemed')).toBe(true);
    // allotment date is a clean ISO string, not a timestamp
    const withDate = g.children.find((c: any) => c.allotment_date);
    expect(withDate.allotment_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('Locker Hub tab = locker deposits (any source) + lockerhub-sourced', async () => {
    const a = await admin();
    const r = await a.get('/api/reports/segments/lockerhub');
    const g = r.json.groups.find((x: any) => x.key === 'NCD-SEG');
    expect(g).toBeTruthy();
    const apps = g.children.map((c: any) => c.application_no);
    expect(apps).toContain('APP-SEG-1');       // source = lockerhub
    expect(apps).toContain('APP-SEG-3');       // a locker deposit (grouped by purpose)
    expect(apps).not.toContain('APP-SEG-2');   // dhanamfin, not a locker deposit
    expect(Number(g.outstanding)).toBe(700000); // APP-SEG-1 + APP-SEG-3 active
  });

  it('Dhanamfin tab = dhanamfin-sourced, non-locker (incl. redeemed)', async () => {
    const a = await admin();
    const r = await a.get('/api/reports/segments/dhanamfin');
    const g = r.json.groups.find((x: any) => x.key === 'NCD-SEG');
    expect(g).toBeTruthy();
    expect(Number(g.outstanding)).toBe(0);     // only APP-SEG-2, which is redeemed
    const apps = g.children.map((c: any) => c.application_no);
    expect(apps).toEqual(['APP-SEG-2']);       // APP-SEG-3 is a locker deposit → under Locker Hub
  });

  it('Locker-deposit drill carries the branch column', async () => {
    const a = await admin();
    const dl = await a.get('/api/dashboard/drill/locker');
    const row = dl.json.rows.find((x: any) => x.application_no === 'APP-SEG-3');
    expect(row).toBeTruthy();
    expect(row.branch).toBe('Seg Test Branch');
  });

  it('Universal search finds an application by its number', async () => {
    const a = await admin();
    const r = await a.get('/api/dashboard/search?q=APP-SEG-1');
    expect(Array.isArray(r.json.applications)).toBe(true);
    const hit = r.json.applications.find((x: any) => x.application_no === 'APP-SEG-1');
    expect(hit).toBeTruthy();
    expect(hit.customer).toBe('Seg One');
    expect(hit.series_code).toBe('NCD-SEG');
  });
});
