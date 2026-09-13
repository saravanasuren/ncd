/**
 * Digio eSign adapter — ported from the wealth app's digio service, trimmed to
 * ncd's model where eSign is OFF the critical path (records esigned_at, doesn't
 * drive a status transition).
 *
 * Auth: HTTP Basic base64(client_id:client_secret). Base URLs:
 *   Production https://api.digio.in (default) · Sandbox https://ext.digio.in.
 *
 * STUB by default: with no creds (or DIGIO_TEST_MODE), initiateSigning returns
 * a synthetic sign_url and never calls the network — so the flow is testable
 * and the deploy is inert until DIGIO_* land in SSM.
 */
import { config } from '../../config.js';

export const digioConfigured = () => !!(config.DIGIO_CLIENT_ID && config.DIGIO_CLIENT_SECRET);
const base = () => config.DIGIO_BASE || 'https://api.digio.in';

async function call(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
  if (!digioConfigured()) {
    // Deterministic stub — mirrors the wealth adapter's shapes.
    if (path.includes('/sign_request') || path.includes('/uploadpdf')) {
      return { id: `STUB-DIGIO-REQ-${Date.now()}`, status: 'requested', signers: [{ sign_url: `about:blank#digio-stub-${Date.now()}` }] };
    }
    return { ok: true, stub: true };
  }
  const auth = Buffer.from(`${config.DIGIO_CLIENT_ID}:${config.DIGIO_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(base() + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Digio ${method} ${path} → ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
  return r.json() as Promise<Record<string, any>>;
}

export interface SignRequestResult {
  digioRequestId: string;
  signUrl: string | null;
  status: string;
}

/** A PDF to be signed — the filled application form (base64). */
export interface SignDocument { fileName: string; contentBase64: string; }

/** Where the sole/1st-applicant signature goes: PDF bottom-left coordinates +
 *  1-indexed page (from the application-form renderer). */
export interface SignaturePlacement { box: { llx: number; lly: number; urx: number; ury: number }; page: number; }

/** One signer on a multi-party document, with their own signature box. */
export interface SignParty {
  name: string;
  phone?: string | null;
  email?: string | null;
  box?: { llx: number; lly: number; urx: number; ury: number };
  page?: number;
}

/** Normalise an Indian mobile to Digio's required +91XXXXXXXXXX. Bare 10-digit
 * numbers get dropped on the SMS channel, so the sign link never arrives
 * (a real Digio gotcha carried over from the wealth adapter). */
function normalisePhone(phone?: string | null): string | undefined {
  if (!phone) return undefined;
  const d = String(phone).replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return ten.length === 10 ? '+91' + ten : undefined;
}

/** Create a Digio sign request for an application's agreement PDF. The document
 * to sign (the application form) is uploaded as base64 — without it Digio would
 * have nothing to sign, so callers pass it in. Inert in stub mode.
 *
 * Payload validated against live Digio 2026-07-21, matched to the wealth
 * adapter's production config. */
export async function createSignRequest(input: {
  signerEmail?: string; signerPhone?: string; signerName?: string; reason?: string;
  document?: SignDocument; signature?: SignaturePlacement;
  /** EVERY signer, when a document is signed by more than one person — a joint
   *  locker hiring (owner 2026-09-12). Digio takes an array natively and marks
   *  the document signed only once all of them have signed, so one request
   *  carries the whole hiring rather than a chain of separate documents.
   *  Overrides the single-signer fields above when given. */
  parties?: SignParty[];
}): Promise<SignRequestResult> {
  const phone = normalisePhone(input.signerPhone);
  // Phone-first identifier so the link goes by SMS (Dhanam's customer base);
  // email + phone as separate fields so Digio delivers on BOTH channels.
  const identifier = phone || input.signerEmail || input.signerPhone || 'unknown';
  const parties: SignParty[] = input.parties?.length
    ? input.parties
    : [{ name: input.signerName || 'Customer', phone: input.signerPhone, email: input.signerEmail,
         box: input.signature?.box, page: input.signature?.page }];
  const identifierOf = (p: SignParty) =>
    normalisePhone(p.phone) || p.email || p.phone || 'unknown';
  // sign_coordinates is keyed BY IDENTIFIER, so two signers sharing one would
  // silently collapse into a single signature box — one of them would never be
  // asked to sign and the document would still complete. Refuse instead.
  const seen = new Set<string>();
  for (const p of parties) {
    const id = identifierOf(p);
    if (seen.has(id)) {
      throw new Error(`Two signers share the contact ${id} — each signer needs their own phone or email.`);
    }
    seen.add(id);
  }
  const body: Record<string, unknown> = {
    signers: parties.map((p) => ({
      identifier: identifierOf(p),
      name: p.name || 'Customer',
      // Shown to the signer as "Reasons for request". Defaults to the investment
      // wording; the locker flows pass their own so a hirer doesn't see "NCD
      // subscription agreement" on a locker document.
      reason: input.reason || 'NCD subscription agreement',
      sign_type: 'aadhaar', // Aadhaar-OTP eSign — not draw-signature-after-login
      email: p.email || undefined,
      phone: normalisePhone(p.phone) || undefined,
    })),
    expire_in_days: 10,
    notify_signers: true,
    send_sign_link: true,
    generate_access_token: true,
    include_authentication_url: 'true',
  };
  if (input.document) { body.file_name = input.document.fileName; body.file_data = input.document.contentBase64; }
  // Place the eSignature in the form's 1st-applicant box. 'custom' is only valid
  // WITH sign_coordinates (Digio rejects it otherwise); without a box Digio
  // defaults to last-page placement (no display_on_page).
  const placed = parties.filter((p) => p.box && p.page);
  if (placed.length) {
    body.display_on_page = 'custom';
    body.sign_coordinates = Object.fromEntries(placed.map((p) =>
      [identifierOf(p), { [String(p.page)]: [p.box] }]));
  }
  const r = await call('POST', '/v2/client/document/uploadpdf', body);
  // Digio may return the signer link at signing_parties[0].authentication_url;
  // usually it's delivered to the signer directly (notify + send_sign_link).
  const returnedParties = Array.isArray(r.signing_parties) ? r.signing_parties : [];
  const signUrl = returnedParties[0]?.authentication_url
    ?? (Array.isArray(r.signers) ? r.signers[0]?.sign_url : undefined)
    ?? r.sign_url ?? null;
  return { digioRequestId: String(r.id), signUrl: (signUrl as string | null) ?? null, status: String(r.status ?? 'requested') };
}

/** Poll Digio for one request's current status (real mode only). */
export async function fetchStatus(digioRequestId: string): Promise<string | null> {
  if (!digioConfigured()) return null;
  const r = await call('POST', '/v2/client/document/status', { id: digioRequestId }).catch(() => null);
  return r ? String((r as Record<string, unknown>).agreement_status ?? (r as Record<string, unknown>).status ?? '') : null;
}

/** Digio "signed" states (a few spellings across their API surface). */
export function isSignedStatus(s: string | null | undefined): boolean {
  return !!s && /^(signed|completed|success|agreement_signed)$/i.test(String(s));
}

/**
 * Download the SIGNED PDF for a completed request. Binary, so it can't go
 * through `call()` (which parses JSON). Returns null in stub mode or on any
 * failure — the caller treats the signed copy as best-effort and never lets a
 * download hiccup block the eSign completion.
 */
export async function downloadSignedDocument(digioRequestId: string): Promise<Buffer | null> {
  if (!digioConfigured()) return null;
  try {
    const auth = Buffer.from(`${config.DIGIO_CLIENT_ID}:${config.DIGIO_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${base()}/v2/client/document/download?document_id=${encodeURIComponent(digioRequestId)}`, {
      headers: { Authorization: 'Basic ' + auth },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
