/** Payment adapter interface (docs/08 §2). All providers share this shape. */
export interface PaymentLink {
  provider: string;
  ref_id: string;
  payment_link: string;
  expires_at: string;
  raw: Record<string, unknown>;
}
export interface VirtualAccount {
  provider: string;
  va_id: string;
  va_account_number: string;
  va_ifsc: string;
  va_handle?: string;
  raw: Record<string, unknown>;
}
export type CollectionStatus = 'Pending' | 'Confirmed' | 'Failed' | 'Reversed';
export interface CollectionResult {
  provider: string;
  status: CollectionStatus;
  utr: string | null;
  paid_at: string | null;
  amount: number | null;
  raw: Record<string, unknown>;
}
export interface PayoutResult {
  provider: string;
  ref_id: string;
  status: string;
  utr: string | null;
  raw: Record<string, unknown>;
}
export interface WebhookVerifyInput {
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export interface PaymentProvider {
  name: string;
  createPaymentLink(a: { amount: number; customer?: unknown; ref?: string; callback_url?: string }): Promise<PaymentLink>;
  createVirtualAccount(a: { customer?: unknown; ref?: string }): Promise<VirtualAccount>;
  getCollectionStatus(a: { ref_id?: string; utr?: string }): Promise<CollectionResult>;
  createPayout(a: { amount: number; beneficiary: { name: string; account: string; ifsc: string }; mode?: 'IMPS' | 'NEFT' | 'RTGS'; ref?: string }): Promise<PayoutResult>;
  getPayoutStatus(a: { ref_id: string }): Promise<PayoutResult>;
  verifyWebhookSignature(a: WebhookVerifyInput): boolean;
}
