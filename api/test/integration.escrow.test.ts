/**
 * Escrow reconciliation end-to-end, against the real SBI sample.
 *
 * Sets up two enrolled investors — one matchable by remitter bank account, one
 * by name — declares the company's own account, uploads the statement, and
 * checks that the parser + matcher bucket every credit the way the dashboard
 * relies on: company floor apart, non-lakh amounts flagged, matched investors
 * attributed, and everyone else surfaced as "received but not enrolled".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const b64 = readFileSync(fileURLToPath(new URL('./fixtures/sbi-escrow-sample.xls', import.meta.url))).toString('base64');
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

beforeAll(async () => {
  ctx = await startTestServer();
  // The company funds a ₹10L floor from its own account — declare it so those
  // credits aren't counted as investments.
  await ctx.db.query(
    `INSERT INTO app_settings (key, value, group_name, label) VALUES ('escrow.company_accounts', '"40000000001"', 'Escrow', 'Company accounts')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
});
afterAll(async () => { await ctx.close(); });

describe('escrow reconciliation', () => {
  it('ingests the statement, matches investors, and buckets the rest', async () => {
    const a = await admin();

    // Investor matchable by REMITTER ACCOUNT (LAKSHMI's ₹5L RTGS, from a/c 46000000004).
    const byAcct = await a.post('/api/customers', { full_name: 'Subbu S', phone: '9846500001' });
    await ctx.db.query(
      `INSERT INTO customer_bank_accounts (customer_id, account_number, ifsc, is_active) VALUES ($1, '46000000004', 'SBIN0000001', TRUE)`,
      [byAcct.json.id]);

    // Investor matchable by NAME (PRIYA's ₹20L RTGS).
    await a.post('/api/customers', { full_name: 'PRIYA S V', phone: '9846500002' });

    const up = await a.post('/api/escrow/statements', { filename: 'sbi.xls', data_base64: b64 });
    expect(up.status).toBe(201);
    expect(up.json.credit_count).toBe(28);
    expect(up.json.inserted).toBe(28);
    expect(up.json.matched).toBeGreaterThanOrEqual(2);

    const sum = await a.get('/api/escrow/summary');
    expect(sum.json.escrow_balance).toBe(12306101);          // the closing balance = escrow balance
    expect(sum.json.escrow_account).toBe('00000045000000001');
    expect(sum.json.breakup.company).toBe(1000100);          // ₹10,00,000 floor + ₹100 test, both self-transfers

    // Both investors attributed by name/account.
    const names = sum.json.breakup.enrolled_investors.map((r: any) => r.full_name);
    expect(names).toContain('PRIYA S V');
    expect(names).toContain('Subbu S');
    const yuva = sum.json.breakup.enrolled_investors.find((r: any) => r.full_name === 'PRIYA S V');
    expect(yuva.total).toBe(2000000);

    // Non-lakh amounts flagged: the ₹1 IMPS test + the ₹1,06,000 NEFT.
    expect(sum.json.breakup.flagged_total).toBe(106001);

    // Real money from people not in the system.
    expect(sum.json.not_enrolled_total).toBeGreaterThan(0);
  });

  it('is idempotent — re-uploading the same window inserts nothing', async () => {
    const a = await admin();
    const again = await a.post('/api/escrow/statements', { filename: 'sbi.xls', data_base64: b64 });
    expect(again.json.inserted).toBe(0);
    expect(again.json.duplicates).toBe(28);
  });

  it('lets a human assign an unmatched cheque to a customer', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Cheque Payer', phone: '9846500003' });
    const lines = await a.get('/api/escrow/lines?status=Unidentified');
    const cheque = lines.json.rows[0];
    expect(cheque).toBeTruthy();
    const res = await a.post(`/api/escrow/lines/${cheque.id}/assign`, { customer_id: cust.json.id });
    expect(res.status).toBe(200);
    const after = await ctx.db.query('SELECT match_status, match_method, matched_customer_id FROM escrow_statement_lines WHERE id = $1', [cheque.id]);
    expect(after.rows[0].match_status).toBe('Matched');
    expect(after.rows[0].match_method).toBe('manual');
  });
});
