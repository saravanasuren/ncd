/**
 * The approver's editable investment panel pre-fills the maker's money-received
 * date into an <input type="date">, which only accepts a bare YYYY-MM-DD value.
 *
 * With node-postgres a DATE / TIMESTAMPTZ column comes back as a JS Date object,
 * and String(date).slice(0,10) yields "Sat Jul 11 2026" — the input silently
 * drops that and shows nothing, so the approver sees an empty date field even
 * though the maker entered one. (PGlite returns strings, so this only bites in
 * prod — hence a unit test that feeds a real Date, not an integration test.)
 */
import { describe, it, expect } from 'vitest';
import { editableForRequest } from '../src/modules/approvals/service.js';
import type { Db } from '../src/db/types.js';

const row = (over: Record<string, unknown>) => ({
  id: 1, application_no: 'APP-2026-000001', total_amount: '300000',
  collection_method: 'NEFT/RTGS', collection_reference: 'UTR123', referred_by_text: 'Agent',
  interest_start_date: null, status: 'PendingApproval',
  series_code: 'NCD_28', scheme_code: '13_M36_13', coupon_rate_pct: '13', tenure_months: 36,
  customer: 'Test Cust', customer_code: 'DHN0001', pan: null,
  ...over,
});
const fakeDb = (r: Record<string, unknown>): Db =>
  ({ query: async () => ({ rows: [r], rowCount: 1 }) }) as unknown as Db;
const req = { entity_type: 'applications', entity_id: '1' };

describe('editableForRequest — date normalisation', () => {
  it('renders a Date-object money-received (node-postgres) as YYYY-MM-DD', async () => {
    const ed = await editableForRequest(fakeDb(row({
      date_money_received: new Date('2026-07-11T00:00:00.000Z'),
      created_at: new Date('2026-07-20T09:35:57.000Z'),
    })), req);
    expect(ed).not.toBeNull();
    expect(ed!.fields.date_money_received).toBe('2026-07-11');
    expect(ed!.fields.date_money_received).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Same normalisation for the read-only "Entered on".
    expect(ed!.readonly.created_at).toBe('2026-07-20');
  });

  it('passes an ISO-string date (PGlite) through unchanged', async () => {
    const ed = await editableForRequest(fakeDb(row({
      date_money_received: '2026-07-11', created_at: '2026-07-20T09:35:57.000Z',
    })), req);
    expect(ed!.fields.date_money_received).toBe('2026-07-11');
  });

  it('leaves a missing date empty rather than "Invalid Date"', async () => {
    const ed = await editableForRequest(fakeDb(row({ date_money_received: null, created_at: new Date('2026-07-20T00:00:00.000Z') })), req);
    expect(ed!.fields.date_money_received).toBe('');
  });
});
