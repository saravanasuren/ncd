/**
 * Classify provider failures correctly, or the retry is worthless.
 *
 * On 28 Jul 2026 WappCloud answered 275 interest messages with
 *   429 "Too many requests from this IP, please try again after 15 minutes"
 * and every one was written off as final. A rate limit clears by itself; a
 * rejected phone number never will. Getting that distinction wrong in either
 * direction is bad: too eager and we hammer a bad number forever, too shy and
 * customers silently go untold.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { wappcloudProvider } from '../src/integrations/notify/wappcloud.js';
import { config } from '../src/config.js';

const meta = { template: 'interest_paid', payload: { name: 'A', amount: '1', month: 'July 2026', date: '28-Jul-2026' } };
const send = (to = '9876543210') => wappcloudProvider().send(to, '', '', meta);

/** `config` is parsed from env once at import, so set it on the object itself.
 *  Without creds the provider short-circuits to "not configured" and never
 *  reaches the classification being tested here. */
const saved = { t: config.WAPPCLOUD_TOKEN, k: config.WAPPCLOUD_API_KEY };
function withCreds() {
  (config as Record<string, unknown>).WAPPCLOUD_TOKEN = 't';
  (config as Record<string, unknown>).WAPPCLOUD_API_KEY = 'k';
}
beforeEach(withCreds);
afterEach(() => {
  vi.unstubAllGlobals();
  (config as Record<string, unknown>).WAPPCLOUD_TOKEN = saved.t;
  (config as Record<string, unknown>).WAPPCLOUD_API_KEY = saved.k;
});

describe('which failures come back', () => {
  it('429 is retryable AND pauses the whole run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Too many requests from this IP', { status: 429 })));
    const r = await send();
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.rateLimited).toBe(true);
  });

  it('a 500 from their end is retryable but does not pause everything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":false}', { status: 500 })));
    const r = await send();
    expect(r.retryable).toBe(true);
    expect(r.rateLimited).toBeFalsy();
  });

  it('a rejected request (400) is final — retrying changes nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":false}', { status: 400 })));
    expect((await send()).retryable).toBeFalsy();
  });

  it('a network drop is retryable — we cannot tell if it landed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    const r = await send();
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it('junk in the phone field is final, not retried forever', async () => {
    // Real values found on the book: "GUN", "SAN", a 9-digit number.
    for (const junk of ['GUN', 'SAN', '919840798']) {
      const r = await send(junk);
      expect(r.ok, junk).toBe(false);
      expect(r.retryable, junk).toBeFalsy();
    }
  });
});
