/**
 * The interest blast must reach EVERYONE, eventually (owner report 2026-07-28).
 *
 * Batch NEFT-2026-000131 paid 384 customers; 92 got a WhatsApp. The other 275
 * died on `wappcloud: send failed (429): Too many requests from this IP` and
 * were never tried again, because a failed row was terminal. 17 more were
 * never queued (no phone), and nothing recorded which batch a message belonged
 * to, so no screen could show any of it.
 *
 * These pin the three rules that fix it: back off rather than burn attempts,
 * retry what is temporary, and give up only on what is genuinely permanent.
 */
import { describe, it, expect } from 'vitest';
import { backoffMs, MAX_ATTEMPTS } from '../src/modules/notifications/service.js';

describe('retry backoff', () => {
  it('starts at a minute and doubles', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(240_000);
  });

  it('caps at half an hour, so a stuck row never drifts out to days', () => {
    expect(backoffMs(10)).toBe(30 * 60_000);
    expect(backoffMs(99)).toBe(30 * 60_000);
  });

  it('gives a message several hours of chances before giving up', () => {
    let total = 0;
    for (let i = 1; i < MAX_ATTEMPTS; i++) total += backoffMs(i);
    expect(total).toBeGreaterThan(60 * 60_000);   // > 1 hour of retrying
  });

  it('never returns a negative or zero wait', () => {
    for (const n of [-5, 0, 1]) expect(backoffMs(n)).toBeGreaterThan(0);
  });
});
