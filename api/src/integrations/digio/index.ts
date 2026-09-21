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
export interface SignaturePlacement {
  box: { llx: number; lly: number; urx: number; ury: number }; page: number;
  /** FURTHER boxes for the same signer. The locker agreement's hirer 1 and its
   *  authorised signatory each sign twice — once in the Schedule's witness table
   *  and once in the closing block — and Digio takes a list of boxes per page,
   *  so both go on one request rather than asking the person to sign twice. */
  also?: Array<{ box: { llx: number; lly: number; urx: number; ury: number }; page: number }>;
}

/** One signer on a multi-party document, with their own signature box(es). */
export interface SignParty {
  name: string;
  phone?: string | null;
  email?: string | null;
  box?: { llx: number; lly: number; urx: number; ury: number };
  page?: number;
  also?: Array<{ box: { llx: number; lly: number; urx: number; ury: number }; page: number }>;
}

/**
 * Digio's `sign_coordinates`: `{ identifier: { page: [box, ...] } }` — a LIST of
 * boxes per page, so ONE signer can be placed in several spots across several
 * pages. The locker agreement needs that: hirer 1 and the authorised signatory
 * each sign the Schedule's witness table AND the closing block, and asking them
 * to sign twice would mean two Digio requests over two different documents.
 *
 * Returns null when nobody has a box, because 'custom' placement without
 * coordinates is rejected by Digio — the caller then leaves display_on_page
 * unset and Digio falls back to its own last-page placement.
 *
 * Exported for testing: the grouping is silent in stub mode, and a signer whose
 * second box quietly vanished would still produce a complete-looking signature.
 */
export function buildSignCoordinates(
  parties: SignParty[], identifierOf: (p: SignParty) => string,
): Record<string, Record<string, unknown[]>> | null {
  const out: Record<string, Record<string, unknown[]>> = {};
  let any = false;
  for (const p of parties) {
    const at = [
      ...(p.box && p.page ? [{ box: p.box, page: p.page }] : []),
      ...(p.also ?? []),
    ];
    if (!at.length) continue;
    any = true;
    const byPage: Record<string, unknown[]> = {};
    for (const q of at) (byPage[String(q.page)] ??= []).push(q.box);
    out[identifierOf(p)] = byPage;
  }
  return any ? out : null;
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
         box: input.signature?.box, page: input.signature?.page, also: input.signature?.also }];
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
  const coords = buildSignCoordinates(parties, identifierOf);
  if (coords) { body.display_on_page = 'custom'; body.sign_coordinates = coords; }
  const r = await call('POST', '/v2/client/document/uploadpdf', body);
  // Digio may return the signer link at signing_parties[0].authentication_url;
  // usually it's delivered to the signer directly (notify + send_sign_link).
  const returnedParties = Array.isArray(r.signing_parties) ? r.signing_parties : [];
  const signUrl = returnedParties[0]?.authentication_url
    ?? (Array.isArray(r.signers) ? r.signers[0]?.sign_url : undefined)
    ?? r.sign_url ?? null;
  return { digioRequestId: String(r.id), signUrl: (signUrl as string | null) ?? null, status: String(r.status ?? 'requested') };
}

/**
 * Ask Digio the current status of one request (real mode only).
 *
 * `GET /v2/client/document/{id}` — verified against live Digio 2026-09-18,
 * which answers 200 with `agreement_status` plus a `signing_parties` array.
 *
 * It used to POST /v2/client/document/status, which Digio answers **405 Method
 * Not Allowed**, and it swallowed that with `.catch(() => null)`. A broken call
 * and "the customer has not signed yet" were therefore the same answer, so the
 * 15-second poller could never see a signature and never retire a dead link.
 * Measured against Digio's own records on 2026-09-18: of 66 sessions we still
 * called 'requested', 8 were signed and unrecorded — TWO NCD application forms,
 * three locker agreements and three authorised-user consents — 36 had expired
 * while still reading "sent to customer, waiting", and only 22 were really open.
 *
 * So this THROWS now. A caller that cannot reach Digio must be able to tell
 * that apart from an unsigned document; null means only "no credentials".
 */
export async function fetchStatus(digioRequestId: string): Promise<string | null> {
  if (!digioConfigured()) return null;
  const r = await call('GET', `/v2/client/document/${encodeURIComponent(digioRequestId)}`);
  return String(r.agreement_status ?? r.status ?? '');
}

/** Digio rate-limits a burst of these (HTTP 429). A caller walking a backlog
 *  should pause rather than hammer, and try the rest next cycle. */
export function isRateLimited(e: unknown): boolean {
  return / 429\b/.test(String((e as Error)?.message ?? ''));
}

/** Digio "signed" states (a few spellings across their API surface). */
export function isSignedStatus(s: string | null | undefined): boolean {
  return !!s && /^(signed|completed|success|agreement_signed)$/i.test(String(s));
}

/**
 * Digio states a request can never leave — the signer declined, the link
 * expired, Digio gave up.
 *
 * Nothing used to read these: only "signed" was acted on, so a dead request sat
 * at 'requested' for ever and every screen went on saying "waiting". A signature
 * that is never coming is a fact about the signing, and has to be recorded as
 * plainly as one that arrives.
 */
export function isFailedStatus(s: string | null | undefined): boolean {
  return !!s && /^(expired|declined|rejected|failed|cancelled|canceled|revoked|aborted)$/i.test(String(s));
}

/**
 * Download the SIGNED PDF for a completed request. Binary, so it can't go
 * through `call()` (which parses JSON). Returns null in stub mode or on any
 * failure — the caller treats the signed copy as best-effort and never lets a
 * download hiccup block the eSign completion.
 */
export async function downloadSignedDocument(digioRequestId: string): Promise<Buffer | null> {
  const r = await fetchSignedDocument(digioRequestId);
  return r.ok ? r.buffer : null;
}

export type SignedDownload = { ok: true; buffer: Buffer } | { ok: false; reason: string };

/**
 * The same download, but it SAYS WHY when it fails.
 *
 * This call has never been checked against live Digio: it dates from 22 Jul, its
 * tests only prove the route 404s before signing, and every stand-in accepts any
 * URL containing "/document/download" — the same blind spot that hid the wrong
 * status call for weeks (#451). So a failure has to be legible to whoever is
 * looking at it, not just null: the reason is logged AND returned, and the
 * resolver puts it in front of the user.
 *
 * Returns a reason for every "no": Digio's HTTP status and the start of its
 * answer, an empty body, a body that is not a PDF, or the network error.
 */
export async function fetchSignedDocument(digioRequestId: string): Promise<SignedDownload> {
  if (!digioConfigured()) return { ok: false, reason: 'e-Sign is not configured on this server' };
  const fail = (reason: string): SignedDownload => {
    console.warn(`[digio] signed-document download for ${digioRequestId}: ${reason}`);
    return { ok: false, reason };
  };
  try {
    const auth = Buffer.from(`${config.DIGIO_CLIENT_ID}:${config.DIGIO_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${base()}/v2/client/document/download?document_id=${encodeURIComponent(digioRequestId)}`, {
      headers: { Authorization: 'Basic ' + auth },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160);
      return fail(`Digio answered HTTP ${r.status}${body ? ` — ${body}` : ''}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return fail('Digio answered with an empty file');
    // A 200 is not proof of a PDF. Storing a JSON/HTML body here made the
    // agreement read "e-Signed" with a file no viewer can open — and the next
    // hirer would have been asked to sign it.
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return fail(`Digio answered 200 with something that is not a PDF (starts ${JSON.stringify(buf.subarray(0, 40).toString('latin1'))})`);
    }
    return { ok: true, buffer: buf };
  } catch (e) {
    return fail(`Digio could not be reached (${(e as Error).message})`);
  }
}
