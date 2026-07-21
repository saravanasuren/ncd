/**
 * LockerHub façade contract tests (docs/08 §1) — the endpoints the DhanamFin /
 * LockerHub app actually calls, asserted against the legacy wealth wire shapes
 * (customer reads L1–L10, auth LA1–LA4, writes, agent auth + webview session).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number, customerId: number;
const PHONE = '9811122233';
const KEY = 'dev-integration-key';

async function integ(method: string, path: string, body?: unknown) {
  const res = await fetch(ctx.base + path, {
    method,
    headers: { 'X-Integration-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function integRaw(path: string) {
  const res = await fetch(ctx.base + path, { headers: { 'X-Integration-Key': KEY } });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buffer, headers: res.headers };
}

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function latestOtp(): Promise<string> {
  const { rows } = await ctx.db.query("SELECT payload FROM notifications_queue WHERE template='portal_otp' ORDER BY id DESC LIMIT 1");
  return (rows[0] as any).payload.otp as string;
}

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);

  // One approved customer with an Active allotted investment.
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: 'Facade Customer', phone: PHONE, email: 'facade@example.com' });
  customerId = cust.json.id; // live on creation — no approval step
  const ncd = await as('ncd@demo.local');
  await a.post(`/api/customers/${customerId}/bank-accounts`, { account_number: '55550009999', ifsc: 'HDFC0005555' });
  await a.put(`/api/customers/${customerId}/nominees`, { nominees: [{ full_name: 'Facade Nominee', share_pct: 100 }] });
  const app = await a.post('/api/applications', { customer_id: customerId, series_id: seriesId, scheme_id: schemeId, amount: 400000, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(ncd, app);
  // Allot so the investment carries an allotment_date (bond certificate exists).
  const allot = await ncd.post(`/api/allotments/series/${seriesId}`, { allotment_date: '2026-07-20' });
  await a.post(`/api/approvals/${allot.json.request.id}/approve`);
  await ctx.db.query("UPDATE customers SET pan = 'AAAPF1111F' WHERE id = $1", [customerId]);
  // The allotment closed the demo series; re-open it so the Open-series
  // endpoints (series/active, subscription-request, locker-deposits) have a
  // live subject, as they will in production.
  await ctx.db.query("UPDATE series SET status = 'Open' WHERE id = $1", [seriesId]);
});
afterAll(async () => { await ctx.close(); });

describe('key auth', () => {
  it('401 without the integration key (legacy paths included)', async () => {
    for (const p of [`/api/integration/customer-by-phone/${PHONE}`, '/api/integration/stats/ncd-aum']) {
      const res = await fetch(ctx.base + p);
      expect(res.status).toBe(401);
    }
  });
});

describe('customer reads L1–L3', () => {
  it('L1 /customer-by-phone (legacy path) returns the wealth shape', async () => {
    const r = await integ('GET', `/api/integration/customer-by-phone/${PHONE}`);
    expect(r.status).toBe(200);
    expect(r.json.found).toBe(true);
    expect(r.json.customer_id).toBe(customerId);
    expect(r.json.name).toBe('Facade Customer');
    expect(r.json.kyc_status).toBeDefined();
    expect(r.json.verified).toBe(true); // creation_status Approved
    expect(r.json.match_count).toBe(1);
    // +91 prefixes normalise to the same customer
    const pref = await integ('GET', `/api/integration/customer-by-phone/+91${PHONE}`);
    expect(pref.json.customer_id).toBe(customerId);
    const missing = await integ('GET', '/api/integration/customer-by-phone/9999999999');
    expect(missing.json).toEqual({ found: false });
  });

  it('ncd-native /customers/by-phone variant still answers', async () => {
    const r = await integ('GET', `/api/integration/customers/by-phone/${PHONE}`);
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(customerId);
    expect(r.json.name).toBe('Facade Customer');
  });

  it('L1.B /customers-by-phone lists all matches', async () => {
    const r = await integ('GET', `/api/integration/customers-by-phone/${PHONE}`);
    expect(r.json.found).toBe(true);
    expect(r.json.count).toBe(1);
    expect(r.json.customers[0]).toMatchObject({ customer_id: customerId, name: 'Facade Customer', verified: true });
  });

  it('L2 holdings carry the full wealth field set + totals block', async () => {
    const r = await integ('GET', `/api/integration/customers/${customerId}/holdings`);
    expect(r.status).toBe(200);
    expect(r.json.customer_id).toBe(customerId);
    expect(r.json.customer_code).toBeTruthy();
    expect(r.json.name).toBe('Facade Customer');
    expect(r.json.totals).toEqual({
      ncd_principal: 400000,
      ncd_principal_excluding_locker_deposits: 400000,
      locker_deposit_via_ncd: 0,
    });
    const h = r.json.holdings[0];
    for (const k of [
      'application_no', 'line_id', 'series_name', 'scheme_name', 'principal', 'coupon_rate_pct',
      'payout_frequency', 'interest_start_date', 'maturity_date', 'status', 'internal_status',
      'customer_status', 'line_status', 'is_matured', 'next_payout_date', 'next_payout_amount',
      'total_interest_paid', 'total_interest_remaining', 'total_interest_projected',
      'nominee_name', 'payout_account_masked', 'is_locker_deposit',
    ]) expect(h, `holding key ${k}`).toHaveProperty(k);
    expect(h.status).toBe('Active');
    expect(h.customer_status).toBe('Active');
    expect(h.principal).toBe(400000);
    expect(typeof h.principal).toBe('number');
    expect(h.nominee_name).toBe('Facade Nominee');
    expect(h.payout_account_masked).toBe('XXXX9999');
    expect(h.next_payout_date).toBeTruthy(); // schedule exists after allotment
    expect(typeof h.next_payout_amount).toBe('number');
    expect(h.total_interest_projected).toBeGreaterThan(0);
    expect(r.json.holdings.every((x: any) => x.is_locker_deposit === false)).toBe(true);
  });

  it('L3 /series/active exposes schemes with ticket rules', async () => {
    const r = await integ('GET', '/api/integration/series/active');
    const s = r.json.series.find((x: any) => x.series_id === seriesId);
    expect(s).toBeTruthy();
    expect(s.amount_raised).toBeGreaterThanOrEqual(400000);
    const sch = s.schemes.find((x: any) => x.scheme_id === schemeId);
    expect(sch).toMatchObject({ coupon_rate_pct: 12, payout_frequency: 'Monthly' });
    for (const k of ['min_ticket', 'multiple_of', 'face_value', 'tenure_months']) expect(sch).toHaveProperty(k);
  });
});

describe('customer reads L7–L10', () => {
  it('L7 transactions: investment credit rows, gross/tds/net breakdown', async () => {
    const r = await integ('GET', `/api/integration/customers/${customerId}/transactions`);
    expect(r.status).toBe(200);
    expect(r.json.customer_code).toBeTruthy();
    const inv = r.json.transactions.find((t: any) => t.type === 'investment');
    expect(inv).toBeTruthy();
    expect(inv).toMatchObject({ gross: 400000, tds: 0, net: 400000, credit: 400000 });
    expect(inv.date).toBe('2026-07-12');
    expect(inv.description).toContain('Investment received via');
    // range filter excludes it
    const filtered = await integ('GET', `/api/integration/customers/${customerId}/transactions?from=2030-01-01`);
    expect(filtered.json.transactions.length).toBe(0);
  });

  it('ledger.csv streams as CSV with the 8-column header', async () => {
    const dl = await integRaw(`/api/integration/customers/${customerId}/ledger.csv`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('text/csv');
    expect(dl.headers.get('content-disposition')).toContain('Ledger-');
    const text = dl.buffer.toString('utf8');
    expect(text.split('\n')[0]).toBe('Date,Application No,Type,Description,Gross (₹),TDS (₹),Net (₹),Reference');
    expect(text).toContain('Investment');
  });

  it('soa.pdf streams a PDF', async () => {
    const dl = await integRaw(`/api/integration/customers/${customerId}/soa.pdf`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('application/pdf');
    expect(dl.buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('L8 documents: list exposes BOND/AGREEMENT/STMT; download enforces ownership', async () => {
    const r = await integ('GET', `/api/integration/customers/${customerId}/documents`);
    const types = r.json.documents.map((d: any) => d.type);
    expect(types).toEqual(expect.arrayContaining(['certificate', 'agreement', 'statement']));
    const bond = r.json.documents.find((d: any) => d.type === 'certificate');
    expect(bond.doc_id).toMatch(/^BOND-\d+$/);
    const dl = await integRaw(`/api/integration/customers/${customerId}/documents/${bond.doc_id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('application/pdf');
    expect(dl.buffer.subarray(0, 4).toString()).toBe('%PDF');
    // another customer id cannot fetch this doc
    const foreign = await integ('GET', `/api/integration/customers/${customerId + 999}/documents/${bond.doc_id}`);
    expect(foreign.status).toBe(404);
    const stmt = await integRaw(`/api/integration/customers/${customerId}/documents/STMT-${customerId}`);
    expect(stmt.buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('L10 stats/ncd-aum returns the rollup + series breakdown', async () => {
    const r = await integ('GET', '/api/integration/stats/ncd-aum');
    expect(r.status).toBe(200);
    for (const k of ['as_of', 'total_issued_cr', 'total_redeemed_cr', 'total_outstanding_cr',
      'apps_total', 'apps_active', 'apps_redeemed', 'customers_total', 'series_breakdown']) {
      expect(r.json).toHaveProperty(k);
    }
    expect(r.json.apps_total).toBeGreaterThan(0);
    const s = r.json.series_breakdown.find((x: any) => x.series_id === seriesId);
    expect(s).toBeTruthy();
    expect(typeof s.issued_cr).toBe('number');
  });
});

describe('customer auth LA1–LA4', () => {
  it('lookup → otp/request → otp/verify → token/validate happy path', async () => {
    const lookup = await integ('POST', '/api/integration/auth/customer/lookup', { phone: PHONE });
    expect(lookup.json.found).toBe(true);
    expect(lookup.json.customer_id).toBe(customerId);
    expect(lookup.json.masked_phone).toBe('••••••' + PHONE.slice(-4));
    expect(lookup.json.multiple_accounts).toBe(false);
    expect(lookup.json.accounts.length).toBe(1);

    const reqOtp = await integ('POST', '/api/integration/auth/otp/request', { phone: PHONE });
    expect(reqOtp.json).toMatchObject({ success: true, masked_destination: '••••••' + PHONE.slice(-4), expires_in_seconds: 600 });

    const otp = await latestOtp();
    const verify = await integ('POST', '/api/integration/auth/otp/verify', { phone: PHONE, otp });
    expect(verify.status).toBe(200);
    expect(verify.json.success).toBe(true);
    expect(verify.json.needs_account_selection).toBe(false);
    expect(verify.json.customer_id).toBe(customerId);
    expect(verify.json.token).toBeTruthy();
    expect(verify.json.expires_in_seconds).toBe(86400);

    const validate = await integ('POST', '/api/integration/auth/token/validate', { token: verify.json.token });
    expect(validate.json.valid).toBe(true);
    expect(validate.json.customer_id).toBe(customerId);
    expect(validate.json.name).toBe('Facade Customer');

    const invalid = await integ('POST', '/api/integration/auth/token/validate', { token: 'garbage' });
    expect(invalid.json).toEqual({ valid: false, reason: 'malformed' });
  });

  it('wrong OTP → 422 with attempts_remaining; unknown phone stays unrevealed', async () => {
    await integ('POST', '/api/integration/auth/otp/request', { phone: PHONE });
    const bad = await integ('POST', '/api/integration/auth/otp/verify', { phone: PHONE, otp: '000000' });
    expect(bad.status).toBe(422);
    expect(bad.json.success).toBe(false);
    expect(bad.json.code).toBe('otp_invalid');
    expect(bad.json.attempts_remaining).toBeGreaterThanOrEqual(0);

    const unknown = await integ('POST', '/api/integration/auth/otp/request', { phone: '9111111111' });
    expect(unknown.json.success).toBe(true); // anti-enumeration
  });
});

describe('customer writes', () => {
  it('customers/from-lockerhub creates then merges (idempotent by phone/PAN)', async () => {
    const body = {
      phone: '9733344455', name: 'Synced Customer', email: 'synced@example.com',
      pan: 'AAAPS2222S', trigger: 'signup_initial',
      address: { line1: '1 Main St', city: 'Erode', state: 'Tamil Nadu', pincode: '638001' },
      bank_account: { account_number: '11223344556', ifsc: 'FDRL0001982', bank_name: 'Federal Bank', holder_name: 'Synced Customer' },
      nominee: { name: 'Synced Nominee', relation: 'Spouse' },
      kyc: { attempts: [
        { document_type: 'PAN', status: 'verified', id_number: 'AAAPS2222S' },
        { document_type: 'AADHAAR', status: 'verified', aadhaar_last4: '1234' },
      ] },
    };
    const first = await integ('POST', '/api/integration/customers/from-lockerhub', body);
    expect(first.status).toBe(200);
    expect(first.json.success).toBe(true);
    expect(first.json.created).toBe(true);
    expect(first.json.customer_code).toBeTruthy();
    expect(first.json.updated_fields).toContain('customer_created');

    const again = await integ('POST', '/api/integration/customers/from-lockerhub', { ...body, name: 'Synced Customer 2' });
    expect(again.json.created).toBe(false);
    expect(again.json.customer_id).toBe(first.json.customer_id);

    // both KYC docs verified → kyc elevated; bank rotated in as active
    const c = (await ctx.db.query('SELECT kyc_status, creation_status FROM customers WHERE id = $1', [first.json.customer_id])).rows[0] as any;
    expect(c.kyc_status).toBe('Verified');
    expect(c.creation_status).toBe('Approved');
    const bank = (await ctx.db.query('SELECT account_number, penny_drop_status FROM customer_bank_accounts WHERE customer_id = $1 AND is_active = TRUE', [first.json.customer_id])).rows[0] as any;
    expect(bank.account_number).toBe('11223344556');

    // synced (application-less) customer is visible on the phone lookups
    const lookup = await integ('GET', '/api/integration/customer-by-phone/9733344455');
    expect(lookup.json.found).toBe(true);
    expect(lookup.json.customer_id).toBe(first.json.customer_id);
  });

  it('profile-update-request lands in the approval queue with a PCR ref', async () => {
    const r = await integ('POST', `/api/integration/customers/${customerId}/profile-update-request`, {
      changes: { full_name: 'Facade Customer Renamed', city: 'Salem', pan: 'AAAPF1111F' },
      reason: 'App-side correction',
    });
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
    expect(r.json.request_no).toMatch(/^PCR-\d{4}-\d{6}$/);
    expect(r.json.status).toBe('PendingApproval');
    expect(r.json.approval_request_id).toBeGreaterThan(0);
    const unsupported = await integ('POST', `/api/integration/customers/${customerId}/profile-update-request`, { changes: { hacker_field: 'x' } });
    expect(unsupported.status).toBe(400);
    expect(unsupported.json.supported_fields).toContain('full_name');
  });

  it('subscription-request creates an Interested lead, idempotent on lockerhub_application_no', async () => {
    const body = { customer_id: customerId, series_id: seriesId, scheme_id: schemeId, requested_amount: 300000, lockerhub_application_no: 'LH-SUB-1', notes: 'from app' };
    const first = await integ('POST', '/api/integration/subscription-request', body);
    expect(first.status).toBe(200);
    expect(first.json.success).toBe(true);
    expect(first.json.reference_id).toMatch(/^LEAD-\d{6}-\d{5}$/);
    expect(first.json.lead_id).toBeGreaterThan(0);
    const again = await integ('POST', '/api/integration/subscription-request', body);
    expect(again.json.already_exists).toBe(true);
    expect(again.json.lead_id).toBe(first.json.lead_id);
    // unmapped series → skipped shape, not an error
    const skipped = await integ('POST', '/api/integration/subscription-request', { ...body, series_id: 'not-mapped' });
    expect(skipped.json).toMatchObject({ success: false, skipped: true });
    // requests list surfaces it with the normalised lifecycle vocabulary
    const reqs = await integ('GET', `/api/integration/customers/${customerId}/requests`);
    const sub = reqs.json.requests.find((x: any) => x.type === 'subscription');
    expect(sub).toBeTruthy();
    expect(sub.status).toBe('pending');
    expect(sub.requested_amount).toBe(300000);
  });

  it('locker-deposits books an NCD (is_locker_deposit) and status polling works', async () => {
    const body = {
      pan: 'AAAPL9999L', phone: '9744455566', name: 'Locker Tenant',
      deposit_amount: 250000, deposit_date: '2026-07-15', deposit_reference: 'LHPAY-DEP-1',
      locker_no: 'L-101', branch: 'Hosur', requires_approval: true,
      source_flag: 'New NCD received as locker deposit payment',
    };
    const first = await integ('POST', '/api/integration/locker-deposits', body);
    expect(first.status).toBe(201);
    expect(first.json.success).toBe(true);
    expect(first.json.ncd_id).toMatch(/^APP-\d{4}-\d{6}$/);
    expect(first.json.approval_status).toBe('pending_approval');
    const again = await integ('POST', '/api/integration/locker-deposits', body);
    expect(again.json.already_processed).toBe(true);
    expect(again.json.ncd_id).toBe(first.json.ncd_id);

    const st = await integ('GET', '/api/integration/ncd/locker-deposit-status?deposit_reference=LHPAY-DEP-1');
    expect(st.status).toBe(200);
    expect(st.json.approval_status).toBe('pending_approval');
    expect(st.json.ncd_id).toBe(first.json.ncd_id);

    const flag = (await ctx.db.query('SELECT is_locker_deposit, status FROM applications WHERE lockerhub_intent_no = $1', ['LHPAY-DEP-1'])).rows[0] as any;
    expect(flag.is_locker_deposit).toBe(true);
    expect(flag.status).toBe('PendingApproval'); // integration money waits in the one approval gate

    const missing = await integ('GET', '/api/integration/ncd/locker-deposit-status?deposit_reference=NOPE');
    expect(missing.status).toBe(404);
  });

  it('ncd/match finds an Active NCD by PAN + exact amount', async () => {
    const hit = await integ('GET', '/api/integration/ncd/match?pan=AAAPF1111F&amount=400000');
    expect(hit.json.found).toBe(true);
    const c = hit.json.candidates[0];
    expect(c.ncd_id).toMatch(/^APP-\d{4}-\d{6}$/);
    expect(c.holder_name).toBe('Facade Customer');
    expect(c.principal).toBe(400000);
    expect(c.status).toBe('Active');
    expect(c.already_linked_to).toBeNull();
    const miss = await integ('GET', '/api/integration/ncd/match?pan=AAAPF1111F&amount=999999');
    expect(miss.json.found).toBe(false);
    expect(miss.json.candidates).toEqual([]);
  });
});

describe('agent endpoints', () => {
  it('from-lockerhub is idempotent on lockerhub_user_id and returns wealth_user_id', async () => {
    const body = { lockerhub_user_id: 424242, full_name: 'Mirror Agent', phone: '9755566677', email: 'mirror.agent@example.com', signed_up_at: new Date().toISOString() };
    const first = await integ('POST', '/api/integration/agents/from-lockerhub', body);
    expect(first.status).toBe(201);
    expect(first.json.ok).toBe(true);
    expect(first.json.wealth_user_id).toBeGreaterThan(0);
    expect(first.json.id).toBe(first.json.wealth_user_id);
    expect(first.json.role).toBe('agent');
    expect(first.json.already_existed).toBe(false);
    expect(first.json.status).toBe('pending_approval');
    const again = await integ('POST', '/api/integration/agents/from-lockerhub', body);
    expect(again.status).toBe(200);
    expect(again.json.already_existed).toBe(true);
    expect(again.json.wealth_user_id).toBe(first.json.wealth_user_id);
    // a DIFFERENT lockerhub user reusing the same phone → 409 contract
    const conflict = await integ('POST', '/api/integration/agents/from-lockerhub', { ...body, lockerhub_user_id: 555555 });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error_code).toBe('PHONE_BELONGS_TO_EXISTING_AGENT');
    expect(conflict.json.user_message).toBeTruthy();
    expect(conflict.json.existing.role).toBe('agent');
    // invalid id type → the self-heal 400
    const badId = await integ('POST', '/api/integration/agents/from-lockerhub', { ...body, lockerhub_user_id: 'abc' });
    expect(badId.status).toBe(400);
    expect(badId.json.error).toContain('positive integer');
  });

  it('email-check answers on GET and POST with is_agent', async () => {
    const g = await integ('GET', '/api/integration/agents/email-check?email=mirror.agent@example.com');
    expect(g.json).toMatchObject({ exists: true, is_agent: true });
    const p = await integ('POST', '/api/integration/agents/email-check', { email: 'admin@dhanam.finance' });
    expect(p.json).toMatchObject({ exists: true, is_agent: false });
    const none = await integ('POST', '/api/integration/agents/email-check', { email: 'ghost@example.com' });
    expect(none.json).toMatchObject({ exists: false, is_agent: false });
  });

  it('authenticate brokers Wealth credentials; webview session returns BOTH handoff shapes', async () => {
    // seed agent: agent@demo.local (users) linked to agents row AG-DEMO
    const bad = await integ('POST', '/api/integration/agents/authenticate', { identifier: 'agent@demo.local', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(bad.json.error).toBe('invalid_credentials');
    const staff = await integ('POST', '/api/integration/agents/authenticate', { identifier: 'admin@dhanam.finance', password: 'whatever' });
    expect(staff.status).toBe(403);
    expect(staff.json.error).toBe('not_an_agent');

    const ok = await integ('POST', '/api/integration/agents/authenticate', { identifier: 'agent@demo.local', password: 'Demo_1234' });
    expect(ok.status).toBe(200);
    expect(ok.json.success).toBe(true);
    expect(ok.json.wealth_user_id).toBeGreaterThan(0);
    expect(ok.json.id).toBe(ok.json.wealth_user_id);
    expect(ok.json.role).toBe('agent');
    expect(ok.json.name).toBe('Demo Agent');

    const res = await fetch(ctx.base + '/api/integration/agents/issue-webview-session', {
      method: 'POST',
      headers: { 'X-Integration-Key': KEY, 'Content-Type': 'application/json', 'X-Acting-As-Agent': String(ok.json.wealth_user_id) },
      body: JSON.stringify({ return_to: '/app/my-earnings', include_wealth_nav: true, logout_redirect: 'https://lockers.dhanamfinance.com/?agent_logout=1' }),
    });
    const s = await res.json() as any;
    expect(res.status).toBe(200);
    // cookie-establish shape
    expect(s.session_code).toBeTruthy();
    expect(s.establish_url).toContain('/api/auth/session/establish?code=');
    expect(s.establish_url).toContain(encodeURIComponent('/app/my-earnings'));
    // legacy bridge shape
    expect(s.token).toBeTruthy();
    expect(s.bridge_url).toContain('#token=');
    expect(s.url).toBe(s.bridge_url);
    expect(s.return_to).toBe('/app/my-earnings');

    // unknown agent id → 404
    const unknown = await fetch(ctx.base + '/api/integration/agents/issue-webview-session', {
      method: 'POST',
      headers: { 'X-Integration-Key': KEY, 'Content-Type': 'application/json', 'X-Acting-As-Agent': '999999' },
      body: JSON.stringify({}),
    });
    expect(unknown.status).toBe(404);
  });
});
