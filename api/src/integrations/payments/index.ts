/**
 * Payment adapter selector (docs/08 §2). Switch via PAYMENT_PRIMARY_PROVIDER=
 * cashfree|easebuzz|stub; a masters Bank may override per-account with its own
 * api_provider. Providers share the PaymentProvider interface (types.ts).
 */
import { config } from '../../config.js';
import type { PaymentProvider } from './types.js';
import { stub } from './stub.js';
import { cashfree } from './cashfree.js';
import { easebuzz } from './easebuzz.js';

export type { PaymentProvider } from './types.js';

const PROVIDERS: Record<string, PaymentProvider> = { stub, cashfree, easebuzz };

export function getDefaultProvider(): PaymentProvider {
  return PROVIDERS[(config.PAYMENT_PRIMARY_PROVIDER || 'stub').toLowerCase()] ?? stub;
}
export function getProvider(name?: string | null): PaymentProvider {
  if (!name) return getDefaultProvider();
  return PROVIDERS[name.toLowerCase()] ?? stub;
}
export function listProviders(): string[] {
  return Object.keys(PROVIDERS);
}
