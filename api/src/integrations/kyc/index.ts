/** KYC provider selector (docs/08 §2). Stub by default; real adapters flip
 * in via KYC_PRIMARY_PROVIDER. */
import { config } from '../../config.js';
import * as stub from './stub.js';
import * as decentro from './decentro.js';

export type { PennyDropResult } from './stub.js';

export function kycProvider() {
  switch (config.KYC_PRIMARY_PROVIDER) {
    case 'decentro': return decentro;
    default:
      return stub;
  }
}
