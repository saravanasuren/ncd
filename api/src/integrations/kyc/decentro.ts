/**
 * Decentro KYC adapter — ported verbatim (semantics + hard-won contract
 * notes) from the old wealth app's integrations/kyc/decentro.js, which runs
 * these endpoints in production today.
 *
 * Auth: client_id + client_secret headers ONLY. Do NOT send module_secret —
 * Decentro's PAN and BAV-v3 routes reject requests carrying an unexpected
 * module_secret header (E00008).
 *
 * Endpoints:
 *   PAN verify   POST /kyc/public_registry/validate
 *   Penny drop   POST /v3/banking/money_transfer/validate_bank_account
 *     (BAV v3 — the only surviving endpoint after Decentro's 2026-07-10
 *      legacy shutdown; consumer_urn mandatory, validation_type mandatory.)
 *
 * v3 correctness note: api_status='SUCCESS' means the CALL worked, not the
 * account — verification is decided by data.account_status ALONE.
 *
 * Falls back to the stub when creds are missing so half-configured deploys
 * keep working (same behaviour as the wealth app).
 */
import { randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import * as stub from './stub.js';
import type { PennyDropResult } from './stub.js';

const hasCreds = () => !!(config.DECENTRO_CLIENT_ID && config.DECENTRO_CLIENT_SECRET);
const base = () => config.DECENTRO_BASE || 'https://in.staging.decentro.tech';
const refId = (prefix: string) => `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;

async function call(path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(base() + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      client_id: config.DECENTRO_CLIENT_ID!,
      client_secret: config.DECENTRO_CLIENT_SECRET!,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any>;
  try { json = JSON.parse(text); } catch { json = { raw_text: text }; }
  if (!res.ok) {
    // Never propagate Decentro's 401/403 as ours — it would log the operator
    // out even though only the UPSTREAM rejected us. Surface the message.
    console.error(`[decentro] ${path} upstream error ${res.status}:`, JSON.stringify(json).slice(0, 800));
    const candidates = [json.message, json.error, json.data?.message, json.data?.error, json.errorMessage, json.error_message, json.responseMessage, json.response_message];
    const detail = candidates.find((v) => typeof v === 'string' && v.trim().length)
      ?? JSON.stringify(json).slice(0, 400);
    throw new Error(`Decentro rejected the request (${res.status}). ${detail}`);
  }
  return json;
}

/** Local fuzzy name match (provider-independent Verified/Mismatch semantics). */
function fuzzyNameMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');
  const an = norm(a), bn = norm(b);
  if (!an || !bn) return false;
  const tokens = (s: string) => new Set(s.toUpperCase().split(/\s+/).filter((t) => t.length >= 3));
  const at = tokens(a), bt = tokens(b);
  let overlap = 0;
  for (const t of at) if (bt.has(t)) overlap++;
  return overlap >= 2 || an === bn;
}

export async function pennyDrop(accountNumber: string, ifsc: string, holderName?: string): Promise<PennyDropResult> {
  const consumerUrn = config.DECENTRO_VBA_CONSUMER_URN || config.DECENTRO_MASTER_CONSUMER_URN;
  if (!hasCreds() || !consumerUrn) return stub.pennyDrop(accountNumber, ifsc);

  const acct = String(accountNumber ?? '').replace(/\D/g, '');
  const ifscClean = String(ifsc ?? '').toUpperCase().trim();
  if (!acct || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscClean)) {
    return { status: 'Failed', detail: 'Account number or IFSC is not in a valid format.' };
  }
  const r = await call('/v3/banking/money_transfer/validate_bank_account', {
    reference_id: refId('pd'),
    purpose_message: 'Bank account verification for NCD payout',
    consumer_urn: consumerUrn,
    validation_type: (config.DECENTRO_VBA_VALIDATION_TYPE || 'hybrid').toLowerCase(),
    beneficiary_details: {
      account_number: acct,
      ifsc: ifscClean,
      ...(holderName ? { name: holderName } : {}),
    },
  });
  const d = r.data ?? {};
  const accountStatus = String(d.account_status ?? '').trim().toUpperCase();
  const verified = accountStatus === 'VALID' || accountStatus === 'NRE' || accountStatus === 'NRE_ACCOUNT';
  const inconclusive = accountStatus === 'INCONCLUSIVE';
  const nameOnRecord: string | undefined = d.beneficiary_name || undefined;

  if (verified && holderName && nameOnRecord && !fuzzyNameMatch(holderName, nameOnRecord)) {
    return { status: 'Failed', detail: `Name mismatch — bank has "${nameOnRecord}"`, holderName: nameOnRecord };
  }
  if (verified) {
    return { status: 'Verified', detail: `decentro: account ${accountStatus.toLowerCase()}`, holderName: nameOnRecord };
  }
  const reason = d.validation_message || d.validationMessage || (inconclusive ? 'Provider could not decide — retry later' : 'Account invalid');
  const code = d.standardized_error_code || d.standardizedErrorCode;
  return { status: 'Failed', detail: `decentro: ${reason}${code ? ` (${code})` : ''}`, holderName: nameOnRecord };
}

export async function verifyPan(pan: string): Promise<{ valid: boolean; name?: string }> {
  if (!hasCreds()) return stub.verifyPan(pan);
  const p = String(pan ?? '').trim().toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(p)) return { valid: false };
  const body: Record<string, unknown> = {
    reference_id: refId('pan'),
    document_type: 'PAN',
    id_number: p,
    consent: 'Y',
    // MUST be >20 and ≤50 chars per Decentro's validator (E00009).
    consent_purpose: 'PAN verification for Dhanam NCD subscription',
  };
  if (config.DECENTRO_MASTER_CONSUMER_URN) body.consumer_urn = config.DECENTRO_MASTER_CONSUMER_URN;
  const r = await call('/kyc/public_registry/validate', body);
  // Current contract nests under kycResult; older docs used data. Accept both.
  const d = r.kycResult ?? r.data ?? {};
  const idStatus = String(d.idStatus ?? d.id_status ?? d.panStatus ?? '').toUpperCase();
  const valid = ['VALID', 'EXISTS'].includes(idStatus)
    || /verified|active/i.test(String(d.panStatus ?? ''))
    || String(r.responseCode ?? '').toUpperCase().startsWith('S')
    || String(r.kycStatus ?? '').toUpperCase() === 'SUCCESS';
  const name = d.name || d.name_on_card || d.nameOnPan || d.name_on_pan || d.full_name || undefined;
  return { valid, name };
}
