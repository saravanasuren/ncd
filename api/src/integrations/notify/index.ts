/**
 * Notification providers (docs/08 §5,§6). Selection:
 *   email    — SES when NOTIFICATIONS_PROVIDER=ses (instance-role auth),
 *              stub otherwise.
 *   whatsapp — WappCloud when its creds are in SSM, stub otherwise.
 *   sms      — stub (Moplet port pending — LockerHub owns SMS today).
 * One interface per channel; `meta` carries the raw queue template+payload
 * for providers (WhatsApp) that send registered templates, not free text.
 */
import { config } from '../../config.js';
import { sesProvider } from './ses.js';
import { wappcloudProvider, wappcloudConfigured } from './wappcloud.js';

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /**
   * Worth trying again later? A rate limit or a provider outage is temporary
   * and MUST be retried — treating it as final is how 275 interest messages
   * were silently abandoned on 28 Jul 2026. A rejected phone number or an
   * unapproved template will fail identically forever, so it stays final.
   * Undefined means final (the conservative reading for an unknown error).
   */
  retryable?: boolean;
  /** Provider asked us to back off (HTTP 429). Pauses the whole drain, not
   *  just this row — the next message would hit the same closed door. */
  rateLimited?: boolean;
}

export interface SendMeta {
  template: string;
  payload: Record<string, unknown>;
  /** Rich HTML body for email. When present, the email provider sends it as the
   *  HTML part with `body` as the plain-text fallback. Ignored by SMS/WhatsApp. */
  html?: string;
}

export interface NotifyProvider {
  send(to: string, subject: string, body: string, meta?: SendMeta): Promise<SendResult>;
}

// Deterministic stub — "sends" successfully and returns a synthetic id.
const stub = (channel: string): NotifyProvider => ({
  async send(to: string) {
    if (!to) return { ok: false, error: 'no destination' };
    return { ok: true, messageId: `stub-${channel}-${Buffer.from(to).toString('hex').slice(0, 8)}` };
  },
});

export function emailProvider(): NotifyProvider {
  if (config.NOTIFICATIONS_PROVIDER === 'ses') return sesProvider();
  return stub('email');
}
export function smsProvider(): NotifyProvider {
  return stub('sms');
}
export function whatsappProvider(): NotifyProvider {
  if (wappcloudConfigured()) return wappcloudProvider();
  return stub('whatsapp');
}

export function providerFor(channel: string): NotifyProvider {
  switch (channel) {
    case 'sms': return smsProvider();
    case 'whatsapp': return whatsappProvider();
    case 'email':
    default: return emailProvider();
  }
}
