/**
 * Which branch earned an investment (owner 2026-08-04).
 *
 * Staff are linked to a branch, so whoever BROUGHT the business names the
 * branch: Rahini A → Tiruppur, Bindhu R → RS Puram.
 *
 * Two owner decisions this pins:
 *   1. Agent-sourced business counts under HO — 706 of 808 investments on the
 *      live book came through agents, who have no branch of their own.
 *   2. The branch is stamped on the investment and NEVER moves. A staff
 *      transfer must not rewrite last month's branch report.
 *
 * And the trap it guards: "brought by" is the REFERRER, not the enroller. The
 * enroller is whoever typed the row in, and on production that is 'Dhanam Admin'
 * for 638 of 808 — deriving from it would put the whole book in one place.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';
import { branchForReferrer } from '../src/modules/applications/branch.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
let hoId: number, tiruppurId: number, rsPuramId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const mk = async (code: string, name: string) => Number((await ctx.db.query(
    `INSERT INTO branches (code, name) VALUES ($1,$2)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [code, name])).rows[0]!.id);
  hoId = await mk('HO', 'HO');
  tiruppurId = await mk('Tiruppur', 'Tiruppur');
  rsPuramId = await mk('RS Puram', 'RS Puram');

  // Two branch staff, exactly the owner's example.
  await ctx.db.query(
    `INSERT INTO users (email, full_name, code, role_id, is_active, is_staff, branch_id, password_hash)
     VALUES ('rahini@demo.local','Rahini A','BR-RAHINI',(SELECT id FROM roles WHERE name='branch_staff'),TRUE,TRUE,$1,NULL),
            ('bindhu@demo.local','Bindhu R','BR-BINDHU',(SELECT id FROM roles WHERE name='branch_staff'),TRUE,TRUE,$2,NULL)
     ON CONFLICT (email) DO NOTHING`, [tiruppurId, rsPuramId]);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

let n = 0;
// Word names on purpose: person-name validation rejects digits, so
// "Branch Case A1" is refused at create and every later assert fails for the
// wrong reason.
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November'];
/** A customer referred by `ref`, with one investment booked by the ADMIN. */
async function invest(ref: string | null, amount = 100000) {
  const a = await admin();
  const phone = `97600000${String(++n).padStart(2, '0')}`;
  const cust = await a.post('/api/customers', {
    full_name: `Branch Case ${NAMES[n % NAMES.length]}`, phone,
    ...(ref ? { referred_by_text: ref } : {}),
  });
  expect(cust.status, JSON.stringify(cust.json)).toBe(201);
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `77${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: '2026-08-04',
  });
  expect(app.status, JSON.stringify(app.json)).toBe(201);
  // Approve it: segmentGrouped counts outstanding + exited only, and a new
  // investment sits at PendingApproval until a checker signs it off.
  const checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  await approveInvestment(checker, app as any);
  return { appId: Number(app.json.id), cid };
}

const branchOf = async (appId: number) => (await ctx.db.query(
  `SELECT b.name FROM applications a LEFT JOIN branches b ON b.id = a.branch_id WHERE a.id = $1`,
  [appId])).rows[0] as { name: string | null } | undefined;

describe("the branch comes from whoever brought the business", () => {
  it("Rahini's investment is Tiruppur", async () => {
    const { appId } = await invest('Rahini A');
    expect((await branchOf(appId))!.name).toBe('Tiruppur');
  });

  it("Bindhu's investment is RS Puram", async () => {
    const { appId } = await invest('Bindhu R');
    expect((await branchOf(appId))!.name).toBe('RS Puram');
  });

  it('their staff CODE works as well as their name', async () => {
    expect((await branchOf((await invest('BR-RAHINI')).appId))!.name).toBe('Tiruppur');
  });

  it('is NOT taken from whoever typed it in — the admin books all of these', async () => {
    // Every investment above is created by admin@dhanam.finance, who has no
    // branch. If the enroller decided it, they would all be HO.
    const { appId } = await invest('Bindhu R');
    expect((await branchOf(appId))!.name).toBe('RS Puram');
  });
});

describe('agent and unattributable business counts under HO', () => {
  it('an agent referrer lands on HO', async () => {
    const { appId } = await invest('RAJU-P');           // an agent, no branch of their own
    expect((await branchOf(appId))!.name).toBe('HO');
  });

  it('no referrer at all lands on HO', async () => {
    const { appId } = await invest(null);
    expect((await branchOf(appId))!.name).toBe('HO');
  });

  it('a staff member with no branch recorded lands on HO, not nowhere', async () => {
    await ctx.db.query(
      `INSERT INTO users (email, full_name, role_id, is_active, is_staff, branch_id, password_hash)
       VALUES ('nobranch@demo.local','Branchless Person',(SELECT id FROM roles WHERE name='branch_staff'),TRUE,TRUE,NULL,NULL)
       ON CONFLICT (email) DO NOTHING`);
    const { appId } = await invest('Branchless Person');
    expect((await branchOf(appId))!.name).toBe('HO');
  });
});

describe('the branch is stamped, not looked up live', () => {
  it('a staff transfer does not move the business they already brought', async () => {
    const { appId } = await invest('Rahini A');
    expect((await branchOf(appId))!.name).toBe('Tiruppur');
    // Rahini transfers to RS Puram.
    await ctx.db.query("UPDATE users SET branch_id = $1 WHERE email = 'rahini@demo.local'", [rsPuramId]);
    expect((await branchOf(appId))!.name).toBe('Tiruppur');   // history holds
    // ...but her NEXT investment goes to the new branch.
    const next = await invest('Rahini A');
    expect((await branchOf(next.appId))!.name).toBe('RS Puram');
    await ctx.db.query("UPDATE users SET branch_id = $1 WHERE email = 'rahini@demo.local'", [tiruppurId]);
  });
});

describe('the branch segment and the dashboard drill', () => {
  it('groups by branch and lists each investment with who brought it', async () => {
    await invest('Bindhu R', 500000);
    const r = await (await admin()).get('/api/dashboard/drill/branch');
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('groups');
    const rsPuram = (r.json.groups as any[]).find((g) => g.key === 'RS Puram');
    expect(rsPuram, 'RS Puram should have business').toBeTruthy();
    const child = rsPuram.children[0];
    // Exactly what the owner asked to see on a branch.
    expect(child.customer).toBeTruthy();
    expect(Number(child.amount)).toBeGreaterThan(0);
    expect(child.date_money_received).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(child.sourced_by).toBe('Bindhu R');
  });

  it('HO appears in its own right, holding the agent business', async () => {
    await invest('RAJU-P', 300000);
    const r = await (await admin()).get('/api/dashboard/drill/branch');
    const ho = (r.json.groups as any[]).find((g) => g.key === 'HO');
    expect(ho).toBeTruthy();
    expect(ho.children.some((c: any) => c.sourced_by === 'RAJU-P')).toBe(true);
  });

  it('the Segments explorer serves the same branch grouping', async () => {
    const r = await (await admin()).get('/api/reports/segments/branch');
    expect(r.status).toBe(200);
    expect(r.json.by).toBe('branch');
    expect((r.json.groups ?? []).length).toBeGreaterThan(0);
  });
});

describe('the helper itself', () => {
  it('falls back to HO for an unknown name rather than returning nothing', async () => {
    expect(await branchForReferrer(ctx.db, 'Nobody At All')).toBe(hoId);
    expect(await branchForReferrer(ctx.db, '')).toBe(hoId);
    expect(await branchForReferrer(ctx.db, null)).toBe(hoId);
  });

  it('matches on the code even when a different person shares the name', async () => {
    expect(await branchForReferrer(ctx.db, 'BR-BINDHU')).toBe(rsPuramId);
  });
});
