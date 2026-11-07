/**
 * What the acknowledgement calls the thing the customer bought.
 *
 * It used to print the SERIES — "SD4 — Subordinate Debt 4". SD1–SD5 are the
 * monthly tranches the subordinate book is split into (migration 107): a
 * bookkeeping division of our own, meaningless to the holder, and easily read
 * as the name of a product they did not buy. Owner 2026-11-07: "i dont want
 * the series name to come as - SD4 or what ever it is. just mention - Non
 * convirtable Debenture thats it".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractText } from './helpers/pdf-text.js';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let sd4Id: number, schemeId: number;
let admin: Client, checker: Client;

beforeAll(async () => {
  ctx = await startTestServer();
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  sd4Id = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ('SD4', 'Subordinate Debt 4', 'Open', 100000, TRUE, DATE '2026-10-31', DATE '2026-10-31') RETURNING id`)).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1, $2)', [sd4Id, schemeId]);
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
});
afterAll(async () => { await ctx.close(); });

const squash = (s: string) => s.replace(/\s+/g, '');

async function investment(seriesId: number, name: string, phone: string): Promise<number> {
  const cust = await admin.post('/api/customers', { full_name: name, phone });
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: Number(cust.json.id),
    series_id: seriesId, scheme_id: schemeId, amount: 400000, date_money_received: '2026-10-05',
  });
  await approveInvestment(checker, app);
  return Number(app.json.id);
}

describe('the acknowledgement names the instrument, not the series', () => {
  it('prints "Investment Type — Non-Convertible Debenture"', async () => {
    const id = await investment(sd4Id, 'Elangovan Demo', '9553110001');
    const { acknowledgmentPdf } = await import('../src/modules/reports/forms/acknowledgment.js');
    const text = squash(extractText(await acknowledgmentPdf(ctx.db, id)));

    expect(text).toContain(squash('Investment Type'));
    expect(text).toContain(squash('Non-Convertible Debenture'));
  });

  it('names neither the series code nor the series name', async () => {
    // The whole point. Both halves of the old value have to be gone — printing
    // "Subordinate Debt 4" without the "SD4" would be no better.
    const id = await investment(sd4Id, 'No Series Named', '9553110002');
    const { acknowledgmentPdf } = await import('../src/modules/reports/forms/acknowledgment.js');
    const text = squash(extractText(await acknowledgmentPdf(ctx.db, id)));

    expect(text).not.toContain(squash('SD4'));
    expect(text).not.toContain(squash('Subordinate Debt 4'));
    // And the old label is gone too: "NCD Series" expands to "Non-Convertible
    // Debenture Series", which beside the new value would say it twice.
    expect(text).not.toContain(squash('NCD Series'));
  });

  it('still renders for a subordinate bond, which carries no series', async () => {
    // The series was joined LEFT precisely for this shape: a subordinate bond
    // has series_id NULL, and an inner join returned no row, so the ack failed
    // with "Application not found" — silently, since activation logs that
    // rather than failing. Nothing reads the series now, so there is no join
    // left to drop the row. Removing a join is the kind of tidy-up that breaks
    // exactly one case, so the case gets a test.
    const sobId = Number((await ctx.db.query(
      `INSERT INTO sob_products (code, name, tenure_months, coupon_rate_pct, payout_frequency, day_count_convention)
       VALUES ('SOB-ACK','Sub Bond Ack', 36, 13.25, 'Monthly', 'Actual365') RETURNING id`)).rows[0]!.id);
    const cust = await admin.post('/api/customers', { full_name: 'Bond No Series', phone: '9553110003' });
    const app = await admin.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: Number(cust.json.id),
      product_type: 'subordinate_bond', sob_product_id: sobId,
      amount: 400000, date_money_received: '2026-10-05',
    });
    expect(app.status).toBe(201);
    const row = (await ctx.db.query<{ series_id: string | null }>(
      'SELECT series_id FROM applications WHERE id = $1', [app.json.id])).rows[0]!;
    expect(row.series_id).toBeNull();

    const { acknowledgmentPdf } = await import('../src/modules/reports/forms/acknowledgment.js');
    const text = squash(extractText(await acknowledgmentPdf(ctx.db, Number(app.json.id))));

    expect(text).toContain(squash('Non-Convertible Debenture'));
    expect(text).toContain(squash('Bond No Series'));
  });

  it('leaves the rest of the investment details alone', async () => {
    const id = await investment(sd4Id, 'Rest Untouched', '9553110004');
    const { acknowledgmentPdf } = await import('../src/modules/reports/forms/acknowledgment.js');
    const text = squash(extractText(await acknowledgmentPdf(ctx.db, id)));

    expect(text).toContain(squash('Application No'));
    expect(text).toContain(squash('Investment Amount'));
    expect(text).toContain(squash('Rs. 4,00,000'));
    expect(text).toContain(squash('Rupees Four Lakh Only'));
    expect(text).toContain(squash('05-Oct-2026'));
  });
});
