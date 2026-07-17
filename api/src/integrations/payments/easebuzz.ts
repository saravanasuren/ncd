/**
 * Easebuzz adapter (docs/08 §2). Collection is Easebuzz-side (via LockerHub);
 * funded payments reach ncd through the façade. API bodies stay stubbed as in
 * the wealth app; the webhook reverse-hash verification is implemented per
 * Easebuzz's documented scheme (HMAC-SHA512 over the reverse pipe string with
 * the salt) so a real webhook is trustworthy once EASEBUZZ_SALT lands in SSM.
 */
import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import type { PaymentProvider, WebhookVerifyInput } from './types.js';
import { stub } from './stub.js';

const tag = <T extends object>(o: T): T => ({ ...o, provider: 'easebuzz' }) as T;

export const easebuzz: PaymentProvider = {
  name: 'easebuzz',
  async createPaymentLink(a) { return tag(await stub.createPaymentLink(a)); },
  async createVirtualAccount(a) { return tag(await stub.createVirtualAccount(a)); },
  async getCollectionStatus(a) { return tag(await stub.getCollectionStatus(a)); },
  async createPayout(a) { return tag(await stub.createPayout(a)); },
  async getPayoutStatus(a) { return tag(await stub.getPayoutStatus(a)); },
  verifyWebhookSignature({ rawBody }: WebhookVerifyInput): boolean {
    const salt = config.EASEBUZZ_SALT;
    const key = config.EASEBUZZ_KEY;
    if (!salt || !key) return false; // not configured → reject (dormant)
    let body: Record<string, string>;
    try { body = JSON.parse(rawBody) as Record<string, string>; } catch { return false; }
    const provided = body.hash;
    if (!provided) return false;
    // Easebuzz response reverse-hash: sha512(salt|status|udf5..udf1|email|firstname|productinfo|amount|txnid|key)
    const parts = [salt, body.status ?? '', body.udf5 ?? '', body.udf4 ?? '', body.udf3 ?? '', body.udf2 ?? '', body.udf1 ?? '',
      body.email ?? '', body.firstname ?? '', body.productinfo ?? '', body.amount ?? '', body.txnid ?? '', key];
    const expected = createHash('sha512').update(parts.join('|')).digest('hex');
    return provided.toLowerCase() === expected;
  },
};
