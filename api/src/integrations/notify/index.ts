/**
 * Notification providers (docs/08 §5,§6). Stub-default; real SES/WappCloud/
 * SMS adapters flip in via config when keys land (the `_call` bodies are the
 * only thing to fill). One interface per channel.
 */
import { config } from '../../config.js';

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface NotifyProvider {
  send(to: string, subject: string, body: string): Promise<SendResult>;
}

// Deterministic stub — "sends" successfully and returns a synthetic id.
const stub = (channel: string): NotifyProvider => ({
  async send(to: string) {
    if (!to) return { ok: false, error: 'no destination' };
    return { ok: true, messageId: `stub-${channel}-${Buffer.from(to).toString('hex').slice(0, 8)}` };
  },
});

export function emailProvider(): NotifyProvider {
  // if (config.NOTIFICATIONS_PROVIDER === 'ses') return sesProvider();  // Phase 6b
  return stub('email');
}
export function smsProvider(): NotifyProvider {
  return stub('sms');
}
export function whatsappProvider(): NotifyProvider {
  // if (config keys present) return wappcloud();  // Phase 6b
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

// Referenced so config import isn't flagged unused before real adapters land.
void config;
