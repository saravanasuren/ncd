/**
 * A staff member owns the customers they REFERRED, not only the ones they
 * keyed in (owner report 2026-07-28).
 *
 * Venkateswari S referred Jayakumar, but admin typed the enrolment in — so
 * `enrolled_by_user_id` was admin and she could not see her own customer, nor
 * add his next investment. Visibility now also follows the referrer, resolved
 * the same way the reports resolve it (users.code first, then full name).
 *
 * The leak guard matters as much as the fix: widening scope must not expose
 * anyone else's customers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
let staffId: number, staffCode: string;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const u = (await ctx.db.query<{ id: string; code: string | null }>(
    "SELECT id, code FROM users WHERE email = 'staff@demo.local'")).rows[0]!;
  staffId = Number(u.id);
  staffCode = 'STF001';
  await ctx.db.query('UPDATE users SET code = $1 WHERE id = $2', [staffCode, staffId]);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const staff = () => as('staff@demo.local');

/** Admin keys in a customer whose "referred by" names someone else. */
async function adminEnrols(name: string, phone: string, referredBy: string | undefined) {
  const a = await admin();
  const r = await a.post('/api/customers', { full_name: name, phone, ...(referredBy ? { referred_by_text: referredBy } : {}) });
  expect(r.status).toBe(201);
  return Number(r.json.id);
}

const visibleToStaff = async (id: number) => {
  const s = await staff();
  return (await s.get(`/api/customers/${id}`)).status;
};

describe('staff can see the customers they referred', () => {
  it('by NAME — the reported case', async () => {
    const id = await adminEnrols('Referred By Name', '9740000001', 'Demo Branch Staff');
    expect(await visibleToStaff(id)).toBe(200);
  });

  it('by CODE — the rename-proof path the enrol form now stores', async () => {
    const id = await adminEnrols('Referred By Code', '9740000002', staffCode);
    expect(await visibleToStaff(id)).toBe(200);
  });

  it('matching ignores case and surrounding spaces', async () => {
    const id = await adminEnrols('Referred Sloppy', '9740000003', '  demo branch staff  ');
    expect(await visibleToStaff(id)).toBe(200);
  });

  it('the customer shows up in their LIST, not just by direct id', async () => {
    const id = await adminEnrols('Referred In List', '9740000004', 'Demo Branch Staff');
    const s = await staff();
    const rows = (await s.get('/api/customers')).json.rows as { id: number }[];
    expect(rows.some((r) => Number(r.id) === id)).toBe(true);
  });

  it('and they can add that customer\'s next investment', async () => {
    const id = await adminEnrols('Referred Invests', '9740000005', 'Demo Branch Staff');
    const s = await staff();
    await s.post(`/api/customers/${id}/bank-accounts`, { account_number: '4440001111', ifsc: 'ICIC0001111' });
    const app = await s.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: id, series_id: seriesId, scheme_id: schemeId, amount: 100000,
    });
    expect(app.status).toBe(201);
  });
});

describe('widening scope must not leak anyone else', () => {
  it('a customer referred to SOMEONE ELSE stays hidden', async () => {
    const id = await adminEnrols('Someone Elses', '9740000006', 'Demo NCD Manager');
    expect(await visibleToStaff(id)).toBe(404);
  });

  it('a customer with NO referrer stays hidden', async () => {
    const id = await adminEnrols('No Referrer', '9740000007', undefined);
    expect(await visibleToStaff(id)).toBe(404);
  });

  it('a blank/whitespace referrer does not match everyone', async () => {
    const id = await adminEnrols('Blank Referrer', '9740000008', '   ');
    expect(await visibleToStaff(id)).toBe(404);
  });

  it('an unmatched free-text referrer stays hidden', async () => {
    const id = await adminEnrols('Unknown Referrer', '9740000009', 'Nobody By That Name');
    expect(await visibleToStaff(id)).toBe(404);
  });

  it('admin still sees everything', async () => {
    const id = await adminEnrols('Admin Sees All', '9740000010', 'Demo NCD Manager');
    const a = await admin();
    expect((await a.get(`/api/customers/${id}`)).status).toBe(200);
  });
});
