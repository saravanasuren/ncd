/**
 * A bank that does not answer must not become a 500.
 *
 * Production, 29 Jul 2026: staff adding a bank account got "Invalid request",
 * ops got an alert email, and the log said
 *   Decentro rejected the request (422). Account validation was initiated
 *   successfully
 * — a sentence that contradicts itself. Decentro's actual body was
 *   {"api_status":"SUCCESS","message":"Account validation was initiated
 *    successfully","data":{"account_status":"inconclusive","validation_message":
 *    "Unexpected response received from underlying provider."},
 *    "response_key":"pending_account_validation"}
 * HTTP 422, but the call SUCCEEDED and came back with a verdict. Our adapter
 * threw on the status code before anything read the verdict.
 *
 * Both halves are pinned here: a verdict must get through, and a genuine
 * rejection must still throw — swallowing bad credentials would silently mark
 * accounts unverified forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pennyDrop } from '../src/integrations/kyc/decentro.js';
import { config } from '../src/config.js';

const saved = {
  id: config.DECENTRO_CLIENT_ID,
  secret: config.DECENTRO_CLIENT_SECRET,
  urn: config.DECENTRO_VBA_CONSUMER_URN,
};

beforeEach(() => {
  // Without creds the adapter short-circuits to the stub and never calls out.
  (config as Record<string, unknown>).DECENTRO_CLIENT_ID = 'id';
  (config as Record<string, unknown>).DECENTRO_CLIENT_SECRET = 'secret';
  (config as Record<string, unknown>).DECENTRO_VBA_CONSUMER_URN = 'urn';
});
afterEach(() => {
  vi.unstubAllGlobals();
  (config as Record<string, unknown>).DECENTRO_CLIENT_ID = saved.id;
  (config as Record<string, unknown>).DECENTRO_CLIENT_SECRET = saved.secret;
  (config as Record<string, unknown>).DECENTRO_VBA_CONSUMER_URN = saved.urn;
});

const reply = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

const ACCOUNT = '50100123456789', IFSC = 'HDFC0000123';

describe('a 422 that carries a verdict', () => {
  /** The exact body production received. */
  const INCONCLUSIVE = {
    decentro_txn_id: '72A4850CCF2D4F3DA147E7D94EABC6C3',
    api_status: 'SUCCESS',
    message: 'Account validation was initiated successfully',
    data: { account_status: 'inconclusive', validation_message: 'Unexpected response received from underlying provider.' },
    response_key: 'pending_account_validation',
  };

  it('is reported, not thrown', async () => {
    reply(422, INCONCLUSIVE);
    const r = await pennyDrop(ACCOUNT, IFSC);
    expect(r.status).toBe('Failed');
  });

  it('says the bank did not answer, not that the account is wrong', async () => {
    reply(422, INCONCLUSIVE);
    const { detail } = await pennyDrop(ACCOUNT, IFSC);
    expect(detail).toMatch(/could not be checked right now/i);
    expect(detail).toMatch(/try again/i);
    expect(detail).not.toMatch(/invalid/i);        // the account may be perfectly fine
  });

  it('a 422 verdict of VALID still verifies the account', async () => {
    reply(422, { api_status: 'SUCCESS', data: { account_status: 'valid', beneficiary_name: 'RAVI SHANKAR' } });
    const r = await pennyDrop(ACCOUNT, IFSC);
    expect(r.status).toBe('Verified');
    expect(r.holderName).toBe('RAVI SHANKAR');
  });
});

describe('a genuine rejection must still fail loudly', () => {
  it('bad credentials throw — never silently treated as unverified', async () => {
    reply(401, { api_status: 'FAILURE', message: 'Invalid client_id or client_secret' });
    await expect(pennyDrop(ACCOUNT, IFSC)).rejects.toThrow(/Decentro rejected the request \(401\)/);
  });

  it('a rejected body with no verdict throws even when the status looks fine', async () => {
    reply(422, { api_status: 'FAILURE', message: 'consumer_urn is mandatory' });
    await expect(pennyDrop(ACCOUNT, IFSC)).rejects.toThrow(/consumer_urn is mandatory/);
  });

  it('SUCCESS with no account_status is not a verdict either', async () => {
    reply(422, { api_status: 'SUCCESS', message: 'Something odd', data: {} });
    await expect(pennyDrop(ACCOUNT, IFSC)).rejects.toThrow(/Decentro rejected the request \(422\)/);
  });

  it('a 500 from Decentro still throws', async () => {
    reply(500, { message: 'Internal Server Error' });
    await expect(pennyDrop(ACCOUNT, IFSC)).rejects.toThrow(/Decentro rejected the request \(500\)/);
  });
});

describe('input guards are unchanged', () => {
  it('a malformed IFSC never reaches the provider', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await pennyDrop(ACCOUNT, 'NOTANIFSC');
    expect(r.status).toBe('Failed');
    expect(f).not.toHaveBeenCalled();
  });
});
