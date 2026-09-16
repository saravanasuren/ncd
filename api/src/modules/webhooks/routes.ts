/**
 * Inbound provider webhooks — no cookie/CSRF (external callers). Each verifies
 * its own shared secret. Mounted BEFORE the CSRF guard in app.ts.
 */
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getDb } from '../../db/index.js';
import { config } from '../../config.js';
import { asyncHandler } from '../../middleware/error.js';

export const webhooksRouter = Router();

function secretOk(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false; // not configured → reject (dormant)
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Digio eSign completion. Digio is configured with a shared secret we check
// against X-Digio-Secret (or ?secret=). Dormant until DIGIO_WEBHOOK_SECRET is set.
webhooksRouter.post('/digio/esign-complete', asyncHandler(async (req, res) => {
  const provided = (req.get('X-Digio-Secret') || String((req.query as Record<string, unknown>).secret ?? '')) || undefined;
  if (!secretOk(provided, config.DIGIO_WEBHOOK_SECRET)) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'bad webhook secret' } });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const digioRequestId = String(body.digio_request_id ?? body.id ?? body.document_id ?? '');
  if (!digioRequestId) { res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'missing request id' } }); return; }

  // ASK DIGIO before believing this.
  //
  // The handler used to take any delivery here as a completed signature: it
  // read the request id and completed the session, without once looking at
  // what the event actually said. Digio posts for more than completion, and
  // for an NCD application this path stamps esigned_at AND signing_method
  // ('the only place that may write esign') — so a delivery for an expired or
  // declined request would have recorded a signature nobody made.
  //
  // The rule elsewhere in this file's module is that a signature is recorded
  // because DIGIO says so. A webhook body is a claim, not Digio saying so, and
  // it arrives from the open internet behind nothing but a shared secret. So
  // the body is used only to learn WHICH request to ask about; the answer
  // comes from Digio's status endpoint. 200 either way — a retry loop over an
  // event we have correctly declined helps nobody.
  const { isSignedStatus, isFailedStatus, fetchStatus, digioConfigured } = await import('../../integrations/digio/index.js');
  const { completeSigning, markSessionFailed } = await import('../../integrations/digio/service.js');
  if (digioConfigured()) {
    const status = await fetchStatus(digioRequestId).catch(() => null);
    if (!isSignedStatus(status)) {
      if (isFailedStatus(status)) await markSessionFailed(getDb(), digioRequestId, status);
      res.json({ ok: true, ignored: true, status });
      return;
    }
  }
  const out = await completeSigning(getDb(), digioRequestId, {
    signedAt: typeof body.signed_at === 'string' ? body.signed_at : undefined,
    signedDocumentUrl: typeof body.signed_document_url === 'string' ? body.signed_document_url : undefined,
    payload: body,
  });
  res.json(out);
}));
