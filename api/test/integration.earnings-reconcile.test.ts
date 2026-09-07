/**
 * My Earnings must reconcile with the Incentives page (owner 2026-09-07: "show
 * both lines in my earnings so it reconciles").
 *
 * They did not, and the reason was invisible on screen. Measured on production
 * for one branch staff member in August: her page said she brought in ₹34L
 * (8 investments she ENROLLED) while the incentives list paid her on ₹38L
 * (10 investments CREDITED to her) — and only ONE investment was on both lists.
 * The other nine she earned as the REFERRER on work colleagues keyed in.
 *
 * Neither figure was wrong. They are different sets, and the page presented
 * them as if they were the same one.
 *
 * What these pin: the credited basis on My Earnings is the SAME basis the
 * Incentives page uses, so the two agree row for row; and the enrolled/referred
 * split adds up to it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const staff = () => as('staff@demo.local');
/** A DISTINCT checker. A maker cannot approve their own investment, and an
 *  investment that never goes Active accrues nothing — which is exactly how the
 *  first version of this file tested nothing at all. */
const checker = () => as('ncd@demo.local');

let staffUserId = 0;
let staffCode = '';

/** An investment enrolled by `who`, optionally referred by a code. */
async function invest(who: Client, name: string, phone: string, amount: number, referredBy?: string) {
  // referred_by_text lives on the CUSTOMER — the application copies it at
  // creation and ignores anything passed on the application itself.
  const cust = await who.post('/api/customers', {
    full_name: name, phone, ...(referredBy ? { referred_by_text: referredBy } : {}),
  });
  const cid = Number(cust.json.id);
  await who.post(`/api/customers/${cid}/bank-accounts`, { account_number: `6161${phone}`, ifsc: 'ICIC0001111' });
  const series = (await who.get('/api/series')).json.rows[0];
  const scheme = (await who.get('/api/schemes')).json.rows[0];
  const create = await who.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid,
    series_id: series.id, scheme_id: scheme.id, amount,
    date_money_received: '2026-08-10',
  });
  await approveInvestment(await checker(), create);
  return Number(create.json.id);
}

const mine = async (c: Client) => (await c.get('/api/incentives/my-earnings')).json;

describe('My Earnings shows both bases and they reconcile', () => {
  it('sets up the production shape: one enrolled, one referred but enrolled by somebody else', async () => {
    const a = await admin();
    const u = (await ctx.db.query<{ id: string; code: string | null; full_name: string }>(
      `SELECT id, code, full_name FROM users WHERE email = 'staff@demo.local'`)).rows[0]!;
    staffUserId = Number(u.id);
    // resolveReferrer matches on users.code OR full_name; the seeded staff user
    // has no code, so the name is the realistic referral value here.
    staffCode = u.code ?? u.full_name;

    const s = await staff();
    await invest(s, 'Enrolled By Staff', '9537000001', 500000);
    // Enrolled by ADMIN, referred by the staff member — the case that made the
    // two screens disagree.
    await invest(a, 'Referred By Staff', '9537000002', 300000, staffCode);
  });

  it('reports the enrolled and the credited totals separately', async () => {
    const d = await mine(await staff());
    // Enrolled: only what they keyed in.
    expect(d.totals.amount).toBe(500000);
    // Credited: what the incentive is actually paid on — includes the referral.
    expect(d.credited.totals.amount).toBeGreaterThanOrEqual(800000);
  });

  it('the split adds up to the credited total — INCLUDING imported accruals', async () => {
    /**
     * The bug this exists for. matrix_cell is NULL on an IMPORTED accrual —
     * 718 of 889 on production — and `NOT (matrix_cell = 'referrer')` is NULL
     * for those, which a FILTER treats as not-true. The first version dropped
     * 81% of rows into neither bucket and showed a breakdown that did not sum
     * to its own total.
     *
     * The earlier version of THIS test passed anyway, because the test
     * environment only ever creates engine rows. So it seeds one the way an
     * import does: with no matrix_cell at all.
     */
    const s2 = await staff();
    // An investment nobody has accrued to her yet, then an accrual on it shaped
    // the way the importer wrote them: no matrix_cell.
    const appId = await invest(await admin(), 'Imported Accrual', '9537000003', 200000);
    await ctx.db.query(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date)
       VALUES ($1, 'staff', $2, NULL, 'pct', 2, 1234, '2026-08-10')
       ON CONFLICT (application_id, payee_type, payee_id) DO UPDATE SET matrix_cell = NULL`,
      [appId, staffUserId]);

    const t = (await mine(s2)).credited.totals;
    expect(t.enrolled_amount + t.referred_amount + t.earlier_amount).toBe(t.amount);
    expect(t.enrolled_investments + t.referred_investments + t.earlier_investments).toBe(t.investments);
    // Each bucket is genuinely populated, or the sum proves nothing.
    expect(t.referred_amount).toBeGreaterThan(0);
    expect(t.earlier_amount).toBeGreaterThan(0);
  });

  it('every month row adds up too, not just the total', async () => {
    for (const r of (await mine(await staff())).credited.by_month) {
      expect(Number(r.enrolled_amount) + Number(r.referred_amount) + Number(r.earlier_amount))
        .toBe(Number(r.amount));
    }
  });

  it('still never exposes accrued or balance — the credited lines are PAID only', async () => {
    // Owner 2026-07-20: "for every role, accrued and pending balance are never
    // exposed — not even as fields in the response". Adding the credited basis
    // must not smuggle them back in, and the first cut of it did exactly that:
    // an "Incentive earned" tile reading bal.accrued.
    const d = await mine(await staff());
    expect(d).not.toHaveProperty('accrued');
    expect(d).not.toHaveProperty('balance');
    expect(d.credited.totals).not.toHaveProperty('incentive');
    expect(d.credited.totals).toHaveProperty('incentive_paid');
    for (const r of d.credited.by_month) expect(r).not.toHaveProperty('incentive');
    for (const r of d.credited.by_series) expect(r).not.toHaveProperty('incentive');
  });

  it('the credited total EQUALS what the Incentives page pays them on', async () => {
    // The reconciliation the owner asked for, asserted directly against the
    // other screen's own endpoint rather than against a re-derived figure.
    const d = await mine(await staff());
    const rows = (await (await admin()).get(
      `/api/incentives/payees/staff/${staffUserId}/accruals`)).json.rows as Array<Record<string, unknown>>;
    const fromIncentives = rows.reduce((sum, r) => sum + Number(r.investment_amount), 0);
    expect(d.credited.totals.amount).toBe(fromIncentives);
  });

  it('month-wise on My Earnings matches month-wise on the Incentives page', async () => {
    const d = await mine(await staff());
    const monthly = (await (await admin()).get(
      `/api/incentives/payees/staff/${staffUserId}/monthly`)).json.rows as Array<Record<string, unknown>>;

    const mineAug = d.credited.by_month.find((r: Record<string, unknown>) => r.month === '2026-08');
    const theirsAug = monthly.find((r) => r.month === '2026-08');
    expect(mineAug).toBeTruthy();
    expect(theirsAug).toBeTruthy();
    expect(Number(mineAug.amount)).toBe(Number(theirsAug!.investment_amount));
    expect(Number(mineAug.investments)).toBe(Number(theirsAug!.investments));
  });

  it('carries the ids the page needs to link through', async () => {
    // "Make everything clickable" needs something to click TO.
    const a = await admin();
    const rows = (await a.get(`/api/incentives/payees/staff/${staffUserId}/accruals`)).json.rows as Array<Record<string, unknown>>;
    await a.post(`/api/incentives/payees/staff/${staffUserId}/accruals/${rows[0]!.application_id}/pay`, {});
    const d = await mine(await staff());
    expect(d.paid_items.length).toBeGreaterThan(0);
    expect(d.paid_items[0].application_id).toBeTruthy();
    expect(d.paid_items[0].customer_id).toBeTruthy();
  });
});

describe('one payee\'s months are not another\'s to read', () => {
  it('branch staff cannot pull a colleague\'s month-wise incentives', async () => {
    // The monthly route takes ANY payee id, and earnings:read-own is held by
    // every branch staff member — so it must NOT accept that permission.
    const s = await staff();
    expect((await s.get('/api/incentives/payees/staff/1/monthly')).status).toBe(403);
  });

  it('...but an admin can', async () => {
    const a = await admin();
    expect((await a.get(`/api/incentives/payees/staff/${staffUserId}/monthly`)).status).toBe(200);
  });
});
