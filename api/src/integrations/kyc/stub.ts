/**
 * Stub KYC provider (docs/08 §2). Real Decentro v3 adapter lands in Phase 6
 * behind the same interface. `KYC_PRIMARY_PROVIDER=stub` (default in dev).
 */
export interface PennyDropResult {
  status: 'Verified' | 'Failed';
  detail: string;
  holderName?: string;
}

export async function pennyDrop(accountNumber: string, ifsc: string): Promise<PennyDropResult> {
  // Deterministic stub: accounts beginning '0000' or blank IFSC "fail" so the
  // failure path is testable; everything else verifies.
  if (!accountNumber || accountNumber.startsWith('0000') || !ifsc) {
    return { status: 'Failed', detail: 'STUB: account could not be verified' };
  }
  return { status: 'Verified', detail: 'STUB: penny-drop verified', holderName: 'VERIFIED HOLDER' };
}

export async function verifyPan(pan: string): Promise<{ valid: boolean; name?: string }> {
  const valid = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan);
  return { valid, name: valid ? 'STUB PAN HOLDER' : undefined };
}
