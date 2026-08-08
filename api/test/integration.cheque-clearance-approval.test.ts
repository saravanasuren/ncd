/**
 * Locker cheque clearance now goes through the Approvals engine (owner
 * 2026-08-07): a maker marks "funds cleared", which raises a
 * locker_cheque_clearance approval; an Admin/CXO approves it, and only then does
 * the cheque flip to Cleared (and settle on LockerHub). Rejecting it leaves the
 * cheque Pending so it can be re-submitted or bounced.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const SELF = { extra: { self_approval_reason: 'Verified the bank credit against the statement; approving as super admin.' } };

async function recordCheque(a: Client, lockerApp: string) {
  const r = await a.post('/api/lockers/cheques', {
    lockerhub_application_id: lockerApp, applicant_name: 'Cheque Payer', leg: 'deposit',
    amount: 300000, cheque_no: '778899', bank_name: 'HDFC', received_on: '2026-08-01',
  });
  expect(r.status).toBe(201);
  return Number(r.json.cheque.id);
}
const chequeRow = async (id: number) =>
  (await ctx.db.query('SELECT status, approval_request_id, cleared_on FROM locker_cheques WHERE id = $1', [id])).rows[0] as { status: string; approval_request_id: string | null; cleared_on: string | null };

describe('locker cheque clearance via Approvals', () => {
  it('funds-cleared raises an approval; the cheque clears only on approve', async () => {
    const a = await admin();
    const chequeId = await recordCheque(a, 'lh-app-clear-1');

    // Maker: funds cleared → raises an approval, cheque stays Pending.
    const req = await a.post(`/api/lockers/cheques/${chequeId}/clear`, { cleared_on: '2026-08-05', reference: 'UTR-CLR-1' });
    expect(req.status).toBe(201);
    const requestId = Number(req.json.request_id);
    let row = await chequeRow(chequeId);
    expect(row.status).toBe('Pending');
    expect(Number(row.approval_request_id)).toBe(requestId);

    // Re-submitting the same cheque is refused while its approval is open.
    const again = await a.post(`/api/lockers/cheques/${chequeId}/clear`, { cleared_on: '2026-08-05' });
    expect(again.status).toBe(409);

    // Checker approves → cheque clears, cleared_on carried from the request.
    const ok = await a.post(`/api/approvals/${requestId}/approve`, SELF);
    expect(ok.status).toBe(200);
    row = await chequeRow(chequeId);
    expect(row.status).toBe('Cleared');
    expect(row.approval_request_id).toBeNull();
    expect(String(row.cleared_on).slice(0, 10)).toBe('2026-08-05');
  });

  it('rejecting the approval leaves the cheque Pending', async () => {
    const a = await admin();
    const chequeId = await recordCheque(a, 'lh-app-clear-2');
    const req = await a.post(`/api/lockers/cheques/${chequeId}/clear`, { cleared_on: '2026-08-05' });
    const requestId = Number(req.json.request_id);

    const rej = await a.post(`/api/approvals/${requestId}/reject`, { reason: 'Cheque not actually credited yet.' });
    expect(rej.status).toBe(200);

    const row = await chequeRow(chequeId);
    expect(row.status).toBe('Pending');
    expect(row.approval_request_id).toBeNull();

    // Free to submit again after a rejection.
    const retry = await a.post(`/api/lockers/cheques/${chequeId}/clear`, { cleared_on: '2026-08-06' });
    expect(retry.status).toBe(201);
  });
});
