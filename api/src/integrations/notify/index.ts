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
}

export interface SendMeta {
  template: string;
  payload: Record<string, unknown>;
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
