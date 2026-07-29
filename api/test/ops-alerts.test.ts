/**
 * Ops error alerts. The behaviour that matters here is the BRAKE: an alerter
 * that mails on every failure turns one bad deploy into a thousand emails, the
 * inbox gets muted, and the next real alert is never read. LockerHub's AUM
 * monitor did exactly this to the management inbox on 2026-07-27.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const sent: Array<{ to: string; subject: string; body: string }> = [];
/** Set to make the next provider lookup blow up. */
let explode = false;

vi.mock('../src/integrations/notify/index.js', () => ({
  emailProvider: () => {
    if (explode) throw new Error('SES down');
    return {
      async send(to: string, subject: string, body: string) {
        sent.push({ to, subject, body });
        return { ok: true, messageId: 'test' };
      },
    };
  },
}));

const { alertOps, alertRecipients, _resetAlertThrottle } = await import('../src/lib/alerts.js');
const { config } = await import('../src/config.js');

const ORIGINAL = config.OPS_ALERT_EMAILS;

beforeEach(() => {
  sent.length = 0;
  _resetAlertThrottle();
  config.OPS_ALERT_EMAILS = 'eashwar.ram@dhanam.finance,prem.karnan@dhanam.finance';
});
afterEach(() => { config.OPS_ALERT_EMAILS = ORIGINAL; vi.useRealTimers(); });

describe('ops alerts', () => {
  it('mails both owners, once each, with the detail', async () => {
    await alertOps('500 on POST /api/payouts', 'boom\nat line 1');
    expect(sent.map((s) => s.to)).toEqual([
      'eashwar.ram@dhanam.finance', 'prem.karnan@dhanam.finance',
    ]);
    expect(sent[0]!.subject).toBe('[NCD] 500 on POST /api/payouts');
    expect(sent[0]!.body).toContain('boom');
    expect(sent[0]!.body).toContain('Time (IST)');
  });

  it('defaults to the two owners even with no env set', () => {
    config.OPS_ALERT_EMAILS = ORIGINAL;
    expect(alertRecipients()).toContain('eashwar.ram@dhanam.finance');
    expect(alertRecipients()).toContain('prem.karnan@dhanam.finance');
  });

  it('collapses a repeating error instead of mailing every occurrence', async () => {
    for (let i = 0; i < 50; i++) await alertOps('500 on GET /api/x', 'the same fault');
    // 50 failures, 1 alert (× 2 recipients) — not 100 mails.
    expect(sent).toHaveLength(2);
  });

  it('treats ids and amounts in one error as the SAME fault', async () => {
    // The identical bug hit for 3 different customers. That is one problem.
    await alertOps('500 on GET /api/customers/101', 'no row for id 101');
    await alertOps('500 on GET /api/customers/202', 'no row for id 202');
    await alertOps('500 on GET /api/customers/303', 'no row for id 303');
    expect(sent).toHaveLength(2);
  });

  it('reports how many repeats were swallowed when it next mails', async () => {
    vi.useFakeTimers();
    await alertOps('500 on GET /api/y', 'flaky');
    for (let i = 0; i < 4; i++) await alertOps('500 on GET /api/y', 'flaky');
    sent.length = 0;
    vi.advanceTimersByTime(31 * 60 * 1000);       // past the 30-min cooldown
    await alertOps('500 on GET /api/y', 'flaky');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toContain('4 more time(s)');
  });

  it('caps the hourly total so a storm of DIFFERENT errors cannot flood either', async () => {
    for (let i = 0; i < 40; i++) await alertOps(`500 on GET /api/route-${String.fromCharCode(97 + i % 26)}${i}`, `distinct fault ${String.fromCharCode(97 + i % 26)}`);
    // 12/hour ceiling × 2 recipients.
    expect(sent).toHaveLength(24);
    expect(sent.at(-1)!.body).toContain('ceiling has been reached');
  });

  it('sends nothing when deliberately silenced', async () => {
    config.OPS_ALERT_EMAILS = '';
    await alertOps('500 on GET /api/z', 'boom');
    expect(sent).toHaveLength(0);
  });

  it('never throws, even if the provider explodes', async () => {
    explode = true;
    try {
      // The alerter must not take down the handler that is already reporting a
      // fault — that would turn one broken route into a dead server.
      await expect(alertOps('500 on GET /api/w', 'boom')).resolves.toBeUndefined();
      expect(sent).toHaveLength(0);
    } finally { explode = false; }
  });
});
