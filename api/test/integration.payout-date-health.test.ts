/**
 * The payout date health check (owner 2026-08-26: "from the system i should not
 * see anything like what just happened").
 *
 * It names any investment whose accrual start disagrees with the day its money
 * arrived, BEFORE the interest run goes out. Warning only — never a block.
 *
 * The two faults it exists to catch, both found by eye on a sheet:
 *   · Senthamil Selvi APP-2026-001030 — single credit, line date left on the
 *     maker's original day after the checker corrected the application.
 *   · Mythili D APP-2026-001083 — credit had NO date of its own and
 *     interest_start_date was left behind the money date.
 *
 * The CONTROL matters as much as the finds: a clubbed investment's credits
 * carry genuinely DIFFERENT dates, and flagging those would train everyone to
 * ignore the warning. Nadesan P and S.Priyanka both look wrong to a naive date
 * comparison and are correct.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const health = async (a: Client) => (await a.get('/api/payouts/date-health')).json.rows as any[];
const forApp = (rows: any[], appId: number) => rows.filter((r) => Number(r.application_id) === appId);

async function makeInvestment(a: Client, name: string, phone: string, amount: number, date: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: date,
  });
  await approveInvestment(await as('ncd@demo.local'), create);
  return { appId: Number(create.json.id), custId: Number(cust.json.id) };
}

describe('payout date health check', () => {
  it('a healthy investment says nothing', async () => {
    const a = await admin();
    const { appId } = await makeInvestment(a, 'Health Clean', '9704400001', 100000, '2026-07-05');
    expect(forApp(await health(a), appId)).toHaveLength(0);
  });

  it("catches Senthamil Selvi's shape — single credit, line left on the old day", async () => {
    const a = await admin();
    const { appId } = await makeInvestment(a, 'Health Selvi', '9704400002', 100000, '2026-08-01');
    // The line keeps the maker's original date while the application was corrected.
    await ctx.db.query("UPDATE application_lines SET date_money_received = '2026-07-29' WHERE application_id = $1", [appId]);

    const rows = forApp(await health(a), appId);
    expect(rows).toHaveLength(1);
    expect(rows[0].issue).toBe('line_before_money');
    expect(rows[0].accrual_start).toBe('2026-07-29');   // what the sheet WILL use
    expect(rows[0].expected_start).toBe('2026-08-01');  // what it should be
    expect(rows[0].days_wrong).toBe(3);                 // 3 days too early
    expect(rows[0].rupees).toBeGreaterThan(0);          // over-paying
    expect(rows[0].customer_name).toBe('Health Selvi');
  });

  it("catches Mythili's shape — no date on the credit and interest_start left behind", async () => {
    const a = await admin();
    const { appId } = await makeInvestment(a, 'Health Mythili', '9704400003', 700000, '2026-08-16');
    await ctx.db.query('UPDATE application_lines SET date_money_received = NULL WHERE application_id = $1', [appId]);
    await ctx.db.query("UPDATE applications SET interest_start_date = '2026-08-15' WHERE id = $1", [appId]);

    const rows = forApp(await health(a), appId);
    expect(rows).toHaveLength(1);
    expect(rows[0].issue).toBe('no_line_date');
    expect(rows[0].accrual_start).toBe('2026-08-15');
    expect(rows[0].expected_start).toBe('2026-08-16');
    expect(rows[0].days_wrong).toBe(1);
    expect(rows[0].rupees).toBeGreaterThan(0);
  });

  it('CONTROL: a clubbed investment with different credit dates is NOT flagged', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Health Clubbed', phone: '9704400004' });
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 50000, date_money_received: '2026-07-05',
    });
    const appId = Number(first.json.id);
    for (const [amount, date] of [[50000, '2026-07-06'], [100000, '2026-07-07']] as const) {
      await a.post('/api/applications', {
        ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
        amount, date_money_received: date, club_with_application_id: appId,
      });
    }
    await approveInvestment(await as('ncd@demo.local'), first);

    // Three credits, three different dates — correct, and must stay silent.
    expect(forApp(await health(a), appId)).toHaveLength(0);
  });

  it('stops reporting once the first period has been paid', async () => {
    const a = await admin();
    const { appId } = await makeInvestment(a, 'Health Settled', '9704400005', 100000, '2026-08-01');
    await ctx.db.query("UPDATE application_lines SET date_money_received = '2026-07-29' WHERE application_id = $1", [appId]);
    expect(forApp(await health(a), appId)).toHaveLength(1);

    // Once a watermark exists it wins the COALESCE outright, so the money date
    // no longer drives the accrual — reporting it would be noise.
    await ctx.db.query(
      "UPDATE disbursement_schedule SET status = 'Paid' WHERE application_id = $1 AND due_type = 'Interest' AND due_date = (SELECT min(due_date) FROM disbursement_schedule WHERE application_id = $1 AND due_type = 'Interest')",
      [appId]);
    expect(forApp(await health(a), appId)).toHaveLength(0);
  });

  it('needs payouts:generate — branch staff cannot see it', async () => {
    const r = await (await as('staff@demo.local')).get('/api/payouts/date-health');
    expect(r.status).toBe(403);
  });
});
