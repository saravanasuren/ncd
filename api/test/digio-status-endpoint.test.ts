/**
 * Asking Digio whether something is signed (incident 2026-09-18).
 *
 * `fetchStatus` called `POST /v2/client/document/status`. Digio answers that
 * **405 Method Not Allowed**, and every caller swallowed the throw with
 * `.catch(() => null)` — so an unreachable Digio and an unsigned document gave
 * the identical answer, and the 15-second poller reported a quiet day for
 * weeks. Measured against Digio's own records, 66 sessions we still called
 * 'requested' were really 8 completed, 36 expired and 22 open: two NCD
 * application forms, three locker agreements and three authorised-user consents
 * had arrived and gone unrecorded, while the 36 dead links still read "sent to
 * customer — waiting for them to sign".
 *
 * Two things are pinned here, and the second matters more than the first:
 *   1. the METHOD and PATH, because a 405 is invisible once it is swallowed;
 *   2. that a failure THROWS instead of reading as "not signed".
 *
 * The network is stubbed at globalThis.fetch — the point is the request we
 * make and what we do with the reply, neither of which needs Digio to be up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ID = 'DID26091713211522316IGY598CTVGIU';
let calls: Array<{ method: string; url: string }> = [];
const realFetch = globalThis.fetch;

/** Digio's real reply shape, trimmed — verified against live Digio 2026-09-18. */
const digioOk = (status: string) => ({
  ok: true, status: 200,
  json: async () => ({
    id: ID, is_agreement: true, agreement_type: 'outbound', agreement_status: status,
    file_name: 'application-1001.pdf', no_of_pages: 2,
    signing_parties: [{ name: 'Sundararaman K.S.', status, identifier: '9787239640', signature_type: 'aadhaar' }],
  }),
  text: async () => '',
});

beforeEach(() => {
  calls = [];
  process.env.DIGIO_CLIENT_ID = 'TEST_ID';
  process.env.DIGIO_CLIENT_SECRET = 'TEST_SECRET';
  vi.resetModules();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DIGIO_CLIENT_ID;
  delete process.env.DIGIO_CLIENT_SECRET;
});

const load = () => import('../src/integrations/digio/index.js');

describe('fetchStatus', () => {
  it('asks GET /v2/client/document/{id} — the call Digio actually answers', async () => {
    globalThis.fetch = (async (url: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      return digioOk('completed');
    }) as never;

    const { fetchStatus } = await load();
    expect(await fetchStatus(ID)).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(`https://api.digio.in/v2/client/document/${ID}`);
    // The call that was being made instead, and its 405, must not come back.
    expect(calls[0]!.url).not.toContain('/document/status');
  });

  it('reads agreement_status, which is where Digio puts the answer', async () => {
    for (const s of ['requested', 'completed', 'expired', 'declined']) {
      vi.resetModules();
      globalThis.fetch = (async () => digioOk(s)) as never;
      const { fetchStatus } = await load();
      expect(await fetchStatus(ID)).toBe(s);
    }
  });

  it('THROWS when Digio refuses, rather than answering "not signed"', async () => {
    // The 405 itself. Returning null here is what hid the incident: the poller
    // read it as "the customer has not signed yet" and moved on.
    globalThis.fetch = (async () => ({
      ok: false, status: 405,
      text: async () => '{"message":"Method not allowed","code":"METHOD_NOT_ALLOWED"}',
      json: async () => ({}),
    })) as never;
    const { fetchStatus } = await load();
    await expect(fetchStatus(ID)).rejects.toThrow(/405/);
  });

  it('recognises a rate limit, so a backlog waits instead of hammering', async () => {
    globalThis.fetch = (async () => ({
      ok: false, status: 429, text: async () => 'Too many requests', json: async () => ({}),
    })) as never;
    const { fetchStatus, isRateLimited } = await load();
    const err = await fetchStatus(ID).catch((e) => e);
    expect(isRateLimited(err)).toBe(true);
    // ...and an ordinary failure is NOT mistaken for one.
    expect(isRateLimited(new Error('Digio GET /x → 500 boom'))).toBe(false);
  });

  it('a signed status is recognised whichever word Digio uses', async () => {
    const { isSignedStatus, isFailedStatus } = await load();
    // 'completed' is what the live API returned for the 8 missed signatures.
    expect(isSignedStatus('completed')).toBe(true);
    expect(isSignedStatus('signed')).toBe(true);
    expect(isSignedStatus('requested')).toBe(false);
    expect(isFailedStatus('expired')).toBe(true);
    expect(isFailedStatus('declined')).toBe(true);
    expect(isFailedStatus('requested')).toBe(false);
  });

  it('returns null ONLY when there are no credentials', async () => {
    delete process.env.DIGIO_CLIENT_ID;
    delete process.env.DIGIO_CLIENT_SECRET;
    vi.resetModules();
    globalThis.fetch = (async () => { throw new Error('must not be called'); }) as never;
    const { fetchStatus } = await load();
    expect(await fetchStatus(ID)).toBe(null);
  });
});
