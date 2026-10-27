/**
 * The 5 PM ops digest (owner 2026-10-21: "i would like u to send me a mail
 * everyday if u have any queries like this ... such cases and other queries
 * which arises and ur doubts").
 *
 * The thing most worth protecting here is not any single check — it is that
 * the mail KEEPS ARRIVING. A digest that silently stops looks exactly like a
 * quiet day, so the all-clear path and the one-broken-check path are pinned as
 * hard as the findings themselves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import { buildDigest, renderDigest, runOpsDigest } from '../src/integrations/ops-digest.js';

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

describe('the digest reads as something a person can act on', () => {
  it('says so plainly when there is nothing to report', () => {
    const body = renderDigest({ sections: [], total: 0 }, '2026-10-21');
    expect(body).toContain('Nothing needs your attention today');
    // The reason the all-clear exists at all: silence must not be ambiguous.
    expect(body).toContain('If it stops arriving, the check itself has broken');
  });

  it('leads with the count, and names what each section is for', () => {
    const body = renderDigest({
      total: 2,
      sections: [{ title: 'Payouts with nowhere to go', blurb: 'Blank on the NEFT file.',
        items: [{ label: 'DHN0001 A Customer', detail: 'no bank account on file' }, { label: 'DHN0002 B Customer' }] }],
    }, '2026-10-21');
    expect(body).toContain('2 thing(s) need a decision today (2026-10-21)');
    expect(body).toContain('PAYOUTS WITH NOWHERE TO GO  (2)');
    expect(body).toContain('Blank on the NEFT file.');
    expect(body).toContain('no bank account on file');
  });
});

describe('what the digest finds', () => {
  it('reports a live investment whose customer cannot be paid', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'No Bank Investor', phone: '9690000001' });
    // deliberately NO bank account
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 500000, date_money_received: '2026-07-10' });
    await approveInvestment(await as('ncd@demo.local'), app);

    const d = await buildDigest(ctx.db);
    const section = d.sections.find((s) => s.title === 'Payouts with nowhere to go');
    expect(section).toBeDefined();
    const row = section!.items.find((i) => i.label.includes('No Bank Investor'));
    expect(row).toBeDefined();
    // The detail decides WHO fixes it — a tick, or a phone call.
    expect(row!.detail).toContain('no bank account on file at all');
  });

  it('groups a whole series maturing into ONE line, not one per investment', async () => {
    // 29 identical lines for one event is how a daily mail stops being read.
    const a = await admin();
    for (const [i, phone] of ['9690000002', '9690000003', '9690000004'].entries()) {
      const nm = ['Matured Alpha', 'Matured Beta', 'Matured Gamma'][i]!;   // letters only — create validation rejects a digit
      const cust = await a.post('/api/customers', { full_name: nm, phone });
      await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: `77${phone}`, ifsc: 'ICIC0001234' });
      const app = await a.post('/api/applications', {
        ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
        amount: 100000, date_money_received: '2026-07-10' });
      await approveInvestment(await as('ncd@demo.local'), app);
      await ctx.db.query("UPDATE applications SET maturity_date = DATE '2026-08-01' WHERE id = $1", [Number(app.json.id)]);
    }
    const section = (await buildDigest(ctx.db)).sections.find((s) => s.title === 'Matured but still Active');
    expect(section).toBeDefined();
    // One row per maturity DATE, carrying the count and the money.
    const row = section!.items.find((i) => i.label.includes('2026-08-01'));
    expect(row).toBeDefined();
    expect(row!.label).toMatch(/3 investment\(s\) worth Rs 3,00,000/);
    expect(section!.items.length).toBeLessThan(3);   // grouped, not listed
  });

  it('a section with nothing in it is left out entirely', async () => {
    const d = await buildDigest(ctx.db);
    expect(d.sections.every((s) => s.items.length > 0)).toBe(true);
  });

  it('one broken check cannot take the whole digest down', async () => {
    // The failure mode that matters most: a digest that stops arriving looks
    // like a quiet day. A check that throws must report itself and let the
    // rest through.
    const original = ctx.db.query.bind(ctx.db);
    let failed = false;
    (ctx.db as unknown as { query: unknown }).query = async (sql: string, p?: unknown[]) => {
      if (!failed && String(sql).includes('locker_agreement_signings')) { failed = true; throw new Error('boom'); }
      return original(sql, p as never);
    };
    try {
      const d = await buildDigest(ctx.db);
      expect(d.sections.length).toBeGreaterThan(0);                       // still produced
      const broken = d.sections.flatMap((s) => s.items).filter((i) => i.label.includes('could not run'));
      expect(broken).toHaveLength(1);                                      // and says which
      expect(broken[0]!.label).toContain('boom');
    } finally { (ctx.db as unknown as { query: unknown }).query = original; }
  });
});

describe('sending', () => {
  it('queues once per day per recipient, however often the cron ticks', async () => {
    await ctx.db.query(
      `INSERT INTO app_settings (key, value, group_name, label, description, editable_by)
       VALUES ('reports.digest_recipients', $1::jsonb, 'Reports', 'Daily ops digest recipients', '', 'super_admin')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(['boss@dhanam.finance'])]);

    const first = await runOpsDigest(ctx.db, '2026-10-21');
    expect(first.emails_queued).toBe(1);
    const again = await runOpsDigest(ctx.db, '2026-10-21');
    expect(again.emails_queued).toBe(0);          // the 15-minute tick must not re-send

    const q = await ctx.db.query(
      "SELECT payload FROM notifications_queue WHERE template = 'ops_digest' AND to_address = 'boss@dhanam.finance'");
    expect(q.rowCount).toBe(1);
    expect(String((q.rows[0] as { payload: { body: string } }).payload.body)).toContain('need a decision today');
  });

  it('stops when switched off, without clearing the recipients', async () => {
    await ctx.db.query(
      `INSERT INTO app_settings (key, value, group_name, label, description, editable_by)
       VALUES ('reports.digest_enabled', 'false'::jsonb, 'Reports', 'Send the daily ops digest', '', 'super_admin')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const r = await runOpsDigest(ctx.db, '2026-10-22');
    expect(r.emails_queued).toBe(0);
    await ctx.db.query("UPDATE app_settings SET value = 'true'::jsonb WHERE key = 'reports.digest_enabled'");
  });
});

describe('products that will never pay', () => {
  /**
   * Owner 2026-10-27: "for ncd doubling and cumulative - interest should not go
   * in this month batch right ? - i see they are getting paid interest."
   *
   * They were — 8 lines, Rs 93,00,000 of principal, Rs 1,74,342 about to go out
   * on 28-10. previewDue had no payout_frequency filter at all, and accrues LIVE
   * from the watermark, so having no Interest rows protected nothing.
   *
   * The allow-list that fixes that is only safe if somebody is TOLD a product
   * sits outside the cash run. These lines carried the frequency 'AtMaturity',
   * which the engine's enum does not contain, so they had no schedule rows and
   * a NULL maturity date: nothing would ever have paid them.
   */
  it('flags live money on a frequency the engine does not know', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Cumulative Investor', phone: '9690000009' });
    await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '779690000009', ifsc: 'ICIC0001234' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 500000, date_money_received: '2026-07-10' });
    await approveInvestment(await as('ncd@demo.local'), app);
    // The live shape exactly: a frequency outside the enum, no maturity date.
    await ctx.db.query(
      "UPDATE application_lines SET payout_frequency = 'AtMaturity' WHERE application_id = $1", [Number(app.json.id)]);
    await ctx.db.query('UPDATE applications SET maturity_date = NULL WHERE id = $1', [Number(app.json.id)]);

    const section = (await buildDigest(ctx.db)).sections.find((s) => s.title === 'Products that will never pay');
    expect(section).toBeDefined();
    const row = section!.items.find((i) => i.label.includes('Cumulative Investor'));
    expect(row).toBeDefined();
    expect(row!.detail).toContain("the engine does not know the frequency 'AtMaturity'");
    expect(row!.detail).toContain('no maturity date');
  });
});
