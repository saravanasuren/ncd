/**
 * Test harness: PGlite-backed API on an ephemeral port + a cookie-aware client.
 *
 * KNOWN BLIND SPOT: PGlite is not node-postgres. Where production returns a
 * BIGINT (every id in this schema) as a STRING, PGlite returns a NUMBER — so a
 * body that a real browser posts as `"42"` arrives here as `42`, and a route
 * that only accepts numbers passes CI while failing for every operator. That
 * shipped once (#426, assigning a referrer on Approvals). When a test covers an
 * id that has been out to the browser and come back, assert the STRING form
 * too; parse such ids with `idFromJson` (api/src/lib/ids.ts).
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PgliteDb } from '../../src/db/pglite.js';
import { setDb } from '../../src/db/index.js';
import { seed } from '../../src/db/seed.js';
import { createApp } from '../../src/app.js';

export interface TestCtx {
  base: string;
  server: Server;
  db: PgliteDb;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestCtx> {
  const db = new PgliteDb();
  await seed(db);
  setDb(db);
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    db,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.close();
    },
  };
}

/**
 * Customer names are letters-and-spaces only (create validation). Tests used
 * to embed the phone number for uniqueness — this keeps the uniqueness by
 * spelling the digits as letters instead ("98111" → "JIBBB").
 */
export function uniqueName(prefix: string, seed: string): string {
  const letters = seed.replace(/\D/g, '').split('').map((d) => 'ABCDEFGHIJ'[Number(d)]).join('');
  return letters ? `${prefix} ${letters}` : prefix;
}

/**
 * POST /api/applications requires the payment evidence (credited date, method,
 * reference AND the receipt photo, stored in the create transaction). Spread
 * this FIRST into a create body; per-test values placed after it override the
 * defaults. Receipt bytes must pass the magic-byte sniff (lib/uploads), hence
 * the real PDF header.
 */
export function requiredInvestmentFields() {
  return {
    date_money_received: '2026-07-10',
    collection_method: 'NEFT/RTGS',
    collection_reference: 'TEST-REF-001',
    receipt: { filename: 'receipt.pdf', mime: 'application/pdf', data_base64: Buffer.from('%PDF-1.4 test-receipt').toString('base64') },
  };
}

/**
 * Take a just-created application live via the investment approval (the new
 * one-gate go-live). `create` is the POST /api/applications response; `checker`
 * must be a DISTINCT user from the app's maker (maker ≠ checker rule). Returns
 * the approval response so callers can assert on it.
 */
export async function approveInvestment(checker: Client, create: { json: { subscription_request?: { id: number } } }) {
  const reqId = create.json.subscription_request?.id;
  if (!reqId) throw new Error('create response had no subscription_request to approve');
  return checker.post(`/api/approvals/${reqId}/approve`);
}

/** Minimal cookie jar over fetch. Sends X-Requested-With for CSRF. */
export class Client {
  private cookies: Record<string, string> = {};
  constructor(private base: string) {}

  /** The session cookies as a header — for responses `req` cannot parse,
   *  e.g. a PDF body, where the caller has to fetch() directly. */
  cookieHeader(): string {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { 'X-Requested-With': 'dhanam' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const val = pair!.slice(eq + 1);
      if (val === '') delete this.cookies[name];
      else this.cookies[name] = val;
    }
    let json: any = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  }
  get(p: string) { return this.req('GET', p); }
  post(p: string, b?: unknown) { return this.req('POST', p, b ?? {}); }
  put(p: string, b?: unknown) { return this.req('PUT', p, b ?? {}); }
  patch(p: string, b?: unknown) { return this.req('PATCH', p, b ?? {}); }
  del(p: string, b?: unknown) { return this.req('DELETE', p, b); }

  /** Fetch raw bytes (for binary downloads like xlsx). */
  async raw(path: string): Promise<{ status: number; buffer: Buffer; headers: Headers }> {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(this.base + path, { headers: cookie ? { Cookie: cookie } : {} });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buffer, headers: res.headers };
  }
}

/**
 * A one-pixel PNG — stands in for the scan of a signed page.
 * Small enough to inline, and real enough to pass the upload sniffer.
 */
export const SIGNED_SCAN_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Raise a staff premature redemption and carry it to the approval queue.
 *
 * WHY THIS EXISTS. Until 2026-11-18 `POST /api/redemptions/premature` created
 * the redemption AND submitted it for approval in one call, so a test could
 * read `.json.request.id` straight off the response. The owner then put the
 * customer's signed request letter between those two steps, and the one-step
 * response no longer carries a request — which is correct behaviour and broke
 * 26 assertions across nine suites that only ever used a redemption as a
 * fixture for something else (payout sheets, locker pledges, UTRs, dates).
 *
 * Those suites are not about the signing gate, so they say so by calling this
 * instead of spelling the gate out nine times. The gate's own behaviour —
 * every refusal, the voiding, the approve-time re-check — is proved in
 * integration.redemption-signing.test.ts, where it belongs.
 *
 * Returns the initiate response with `request` filled in, exactly the shape
 * the one-step call used to return, so the call sites needed no other change.
 */
export async function redeemPrematurely(
  client: Client,
  body: { application_id: number; reason: string; redemption_date?: string; amount?: number },
): Promise<{ status: number; json: any }> {
  const created = await client.post('/api/redemptions/premature', body);
  // Pass refusals straight back: several callers assert on them (a pledged
  // investment, an over-sized partial), and swallowing one here would turn a
  // meaningful 4xx into a confusing failure three lines later.
  if (created.status !== 201) return created;

  const rid = Number(created.json.redemption_id);
  // The date on the paper, not the redemption date — several callers redeem on
  // a future date, and a signature cannot be dated after today.
  const signedOn = new Date().toISOString().slice(0, 10);
  const up = await client.post(`/api/redemptions/${rid}/signed-letter`, {
    data_base64: SIGNED_SCAN_PNG, filename: `signed-${rid}.png`, signed_on: signedOn,
  });
  if (up.status !== 201) throw new Error(`redeemPrematurely: signed letter rejected — ${JSON.stringify(up.json)}`);
  const submit = await client.post(`/api/redemptions/${rid}/submit-for-approval`);
  if (submit.status !== 201) throw new Error(`redeemPrematurely: submit rejected — ${JSON.stringify(submit.json)}`);
  return { status: created.status, json: { ...created.json, request: submit.json.request } };
}
