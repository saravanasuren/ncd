/**
 * Cashfree adapter (docs/08 §2). Collection/payout API bodies stay stubbed —
 * ncd's funded-payment path is the LockerHub façade, same as the wealth app —
 * but the webhook signature verification is REAL (Cashfree PG scheme:
 * HMAC-SHA256 of `${timestamp}${rawBody}` with the secret key, base64,
 * header x-webhook-signature). This lets a real Cashfree webhook be trusted
 * the moment CASHFREE_SECRET_KEY lands in SSM.
 */
import { createHmac } from 'node:crypto';
import { config } from '../../config.js';
import type { PaymentProvider, WebhookVerifyInput } from './types.js';
import { stub } from './stub.js';

const tag = <T extends object>(o: T): T => ({ ...o, provider: 'cashfree' }) as T;

export const cashfree: PaymentProvider = {
  name: 'cashfree',
  async createPaymentLink(a) { return tag(await stub.createPaymentLink(a)); },
  async createVirtualAccount(a) { return tag(await stub.createVirtualAccount(a)); },
  async getCollectionStatus(a) { return tag(await stub.getCollectionStatus(a)); },
  async createPayout(a) { return tag(await stub.createPayout(a)); },
  async getPayoutStatus(a) { return tag(await stub.getPayoutStatus(a)); },
  verifyWebhookSignature({ headers, rawBody }: WebhookVerifyInput): boolean {
    const secret = config.CASHFREE_SECRET_KEY;
    if (!secret) return false; // not configured → reject (dormant)
    const ts = headers['x-webhook-timestamp'];
    const sig = headers['x-webhook-signature'];
    if (!ts || !sig) return false;
    const expected = createHmac('sha256', secret).update(ts + rawBody).digest('base64');
    return sig === expected;
  },
};
