/**
 * Pincode → city/state lookup. Pure function with an injected fetch (no network
 * in tests). Fails safe: an invalid/unknown PIN or a bad response returns null
 * so the enrolment form falls back to manual city/state entry.
 */
import { describe, it, expect, vi } from 'vitest';
import { lookupPincode, normalisePincode } from '../src/integrations/pincode.js';

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const notOk = () => ({ ok: false, json: async () => ([]) }) as unknown as Response;

describe('normalisePincode', () => {
  it('accepts a 6-digit PIN, rejects malformed ones', () => {
    expect(normalisePincode(' 641001 ')).toBe('641001');
    expect(normalisePincode('012345')).toBeNull(); // cannot start with 0
    expect(normalisePincode('12345')).toBeNull();  // too short
    expect(normalisePincode('abcdef')).toBeNull();
  });
});

describe('lookupPincode', () => {
  it('maps an India Post hit to state + city (District)', async () => {
    const fetchImpl = vi.fn(async () => ok([{ Status: 'Success', PostOffice: [{ State: 'Tamil Nadu', District: 'Coimbatore', Name: 'RS Puram' }] }]));
    const info = await lookupPincode('641002', fetchImpl as any);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.postalpincode.in/pincode/641002', expect.any(Object));
    expect(info).toMatchObject({ pincode: '641002', state: 'Tamil Nadu', district: 'Coimbatore', city: 'Coimbatore' });
  });

  it('does NOT hit the network for an invalid PIN', async () => {
    const fetchImpl = vi.fn(async () => ok([]));
    expect(await lookupPincode('nope', fetchImpl as any)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null on non-OK, a non-Success status, or a thrown fetch', async () => {
    expect(await lookupPincode('641001', (async () => notOk()) as any)).toBeNull();
    expect(await lookupPincode('641001', (async () => ok([{ Status: 'Error', PostOffice: null }])) as any)).toBeNull();
    expect(await lookupPincode('641001', (async () => { throw new Error('net'); }) as any)).toBeNull();
  });
});
