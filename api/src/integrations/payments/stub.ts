/** In-process payment stub — realistic-shaped responses, no provider keys.
 * Ported from the wealth app's payments/stub.js. */
import type { PaymentProvider } from './types.js';

const rid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const stub: PaymentProvider = {
  name: 'stub',
  async createPaymentLink({ amount, customer, ref, callback_url }) {
    const id = rid('plk');
    return {
      provider: 'stub', ref_id: id,
      payment_link: `https://stub.dhanam.local/pay/${id}?amount=${amount}&ref=${encodeURIComponent(ref ?? '')}`,
      expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      raw: { amount, customer, ref, callback_url, simulated: true },
    };
  },
  async createVirtualAccount({ customer, ref }) {
    const id = rid('va');
    const acct = '9999' + String(Date.now()).slice(-10);
    return { provider: 'stub', va_id: id, va_account_number: acct, va_ifsc: 'YESB0CMSNOC', va_handle: `dhanam.${String(ref ?? acct).toLowerCase()}@yesbank`, raw: { customer, ref, simulated: true } };
  },
  async getCollectionStatus({ ref_id, utr }) {
    const conf = (ref_id?.startsWith('paid_')) || (utr?.startsWith('PAID'));
    return { provider: 'stub', status: conf ? 'Confirmed' : 'Pending', utr: conf ? (utr ?? 'UTR' + Date.now()) : null, paid_at: conf ? new Date().toISOString() : null, amount: null, raw: { ref_id, utr, simulated: true } };
  },
  async createPayout({ amount, beneficiary, mode = 'IMPS', ref }) {
    return { provider: 'stub', ref_id: rid('po'), status: 'Pending', utr: null, raw: { amount, beneficiary, mode, ref, simulated: true } };
  },
  async getPayoutStatus({ ref_id }) {
    return { provider: 'stub', ref_id, status: 'Paid', utr: 'STUB' + Date.now(), raw: { ref_id, simulated: true } };
  },
  verifyWebhookSignature({ rawBody }) { return !!rawBody; },
};
