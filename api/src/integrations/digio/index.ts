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
    if (path.includes('/sign_request')) {
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

/** Create a Digio sign request for an application's agreement PDF. */
export async function createSignRequest(input: { signerEmail?: string; signerPhone?: string; signerName?: string }): Promise<SignRequestResult> {
  const r = await call('POST', '/v2/client/document/sign_request', {
    signers: [{ identifier: input.signerEmail || input.signerPhone || 'unknown', name: input.signerName, reason: 'NCD subscription agreement' }],
    expire_in_days: 10,
    display_on_page: 'custom',
  });
  const signer = Array.isArray(r.signers) ? r.signers[0] : undefined;
  return { digioRequestId: String(r.id), signUrl: signer?.sign_url ?? null, status: String(r.status ?? 'requested') };
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
