/**
 * Series register (Segments → series-wise) regressions, both surfaced by NCD_28
 * reading "₹15,00,000 issued / ₹10,00,000 outstanding / Invalid Date":
 *
 *  1. `issued` must NOT count PendingApproval money. Since the go-live change
 *     that is where every new investment waits — unapproved, no money received —
 *     so counting it inflated the register against the outstanding book.
 *  2. `window_from/to` must be real ISO dates. The driver returns a JS Date for
 *     the min/max aggregates and String(date).slice(0,10) gave "Sat Jul 18",
 *     which the UI rendered as "Invalid Date".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('series register — issued excludes unapproved money; window is a real date', () => {
  it('an approved ₹10L counts as issued; a PendingApproval ₹5L does not', async () => {
    const a = await admin();
    const ncd = await as('ncd@demo.local');

    // Live money: approved → Active, with a money-received date.
    const c1 = await a.post('/api/customers', { full_name: 'Register Live', phone: '9877000001' });
    const live = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: c1.json.id, series_id: seriesId, scheme_id: schemeId, amount: 1000000, date_money_received: '2026-07-18',
    });
    await approveInvestment(ncd, live);

    // Unapproved subscription: sits in PendingApproval with NO money received.
    const c2 = await a.post('/api/customers', { full_name: 'Register Pending', phone: '9877000002' });
    const pending = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: c2.json.id, series_id: seriesId, scheme_id: schemeId, amount: 500000,
    });
    expect((await a.get(`/api/applications/${pending.json.id}`)).json.application.status).toBe('PendingApproval');

    const seg = await a.get('/api/reports/segments/series');
    expect(seg.status).toBe(200);
    const demo = (seg.json.groups as any[]).find((g) => g.key === 'NCD DEMO');
    expect(demo).toBeTruthy();

    // Issued counts the approved ₹10L only — the unapproved ₹5L is excluded.
    expect(Number(demo.issued)).toBe(1000000);
    expect(Number(demo.outstanding)).toBe(1000000);
    expect(Number(demo.issued)).toBeGreaterThanOrEqual(Number(demo.outstanding));

    // Window dates are real ISO dates the UI can parse (not "Sat Jul 18").
    expect(demo.window_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(demo.window_to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(`${demo.window_to}T00:00:00`).getTime())).toBe(false);
  });

  it('approving the pending investment then folds it into issued', async () => {
    const a = await admin();
    const ncd = await as('ncd@demo.local');
    const c = await a.post('/api/customers', { full_name: 'Register Later', phone: '9877000003' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: c.json.id, series_id: seriesId, scheme_id: schemeId, amount: 700000, date_money_received: '2026-07-19',
    });

    const before = Number(((await a.get('/api/reports/segments/series')).json.groups as any[]).find((g) => g.key === 'NCD DEMO').issued);
    await approveInvestment(ncd, app); // money verified → now issued
    const after = Number(((await a.get('/api/reports/segments/series')).json.groups as any[]).find((g) => g.key === 'NCD DEMO').issued);

    expect(after - before).toBe(700000);
  });
});
