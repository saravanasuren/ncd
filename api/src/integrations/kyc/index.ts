/** KYC provider selector (docs/08 §2). Stub by default; real adapters flip
 * in via KYC_PRIMARY_PROVIDER. */
import { config } from '../../config.js';
import * as stub from './stub.js';

export type { PennyDropResult } from './stub.js';

export function kycProvider() {
  switch (config.KYC_PRIMARY_PROVIDER) {
    // case 'decentro': return decentro; // Phase 6
    default:
      return stub;
  }
}
