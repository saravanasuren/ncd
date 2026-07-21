/**
 * IFSC directory lookup. Pure function — the fetch is injected so no test
 * touches the network. Must fail safe: an invalid or unknown code returns null
 * so the bank form falls back to manual entry rather than blocking enrolment.
 */
import { describe, it, expect, vi } from 'vitest';
import { lookupIfsc, normaliseIfsc } from '../src/integrations/ifsc.js';

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const notOk = () => ({ ok: false, json: async () => ({}) }) as unknown as Response;

describe('normaliseIfsc', () => {
  it('accepts and upper-cases a valid IFSC, rejects malformed ones', () => {
    expect(normaliseIfsc(' hdfc0000001 ')).toBe('HDFC0000001');
    expect(normaliseIfsc('HDFC1000001')).toBeNull();   // 5th char must be 0
    expect(normaliseIfsc('HDF0000001')).toBeNull();     // too short
    expect(normaliseIfsc('')).toBeNull();
  });
});

describe('lookupIfsc', () => {
  it('maps a directory hit to bank/branch fields', async () => {
    const fetchImpl = vi.fn(async () => ok({
      BANK: 'HDFC Bank', BRANCH: 'MG Road', CITY: 'BANGALORE', STATE: 'KARNATAKA',
      DISTRICT: 'BANGALORE URBAN', ADDRESS: '12 MG Road', IFSC: 'HDFC0000001',
    }));
    const info = await lookupIfsc('hdfc0000001', fetchImpl as any);
    expect(fetchImpl).toHaveBeenCalledWith('https://ifsc.razorpay.com/HDFC0000001', expect.any(Object));
    expect(info).toMatchObject({ ifsc: 'HDFC0000001', bank: 'HDFC Bank', branch: 'MG Road', city: 'BANGALORE', state: 'KARNATAKA' });
  });

  it('does NOT hit the network for an invalid IFSC', async () => {
    const fetchImpl = vi.fn(async () => ok({}));
    expect(await lookupIfsc('nope', fetchImpl as any)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null on a non-OK response, a bodyless hit, or a thrown fetch', async () => {
    expect(await lookupIfsc('HDFC0000001', (async () => notOk()) as any)).toBeNull();
    expect(await lookupIfsc('HDFC0000001', (async () => ok({ IFSC: 'HDFC0000001' })) as any)).toBeNull(); // no BANK
    expect(await lookupIfsc('HDFC0000001', (async () => { throw new Error('network'); }) as any)).toBeNull();
  });
});
