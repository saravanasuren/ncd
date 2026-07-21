/**
 * WappCloud WhatsApp Business sender — ported from the wealth app's
 * integrations/whatsapp/wappcloud.js (runs in production today).
 *
 * WhatsApp only permits APPROVED template messages for business-initiated
 * sends, so this provider maps our queue templates to registered WappCloud
 * template names. Currently approved: the login OTP template
 * (WAPPCLOUD_OTP_TEMPLATE, body "*{{1}}* is your Dhanam login OTP…").
 * Other templates fail with a clear error until approved counterparts exist.
 *
 * WHATSAPP_TEST_PHONE (SSM) redirects EVERY message to that number — rehearse
 * without messaging real customers; delete the param + restart to go live.
 */
import { config } from '../../config.js';
import type { NotifyProvider, SendMeta } from './index.js';

const endpoint = () => config.WAPPCLOUD_ENDPOINT || 'https://api.wappcloud.com/api/v1/external/process';

export const wappcloudConfigured = () => !!(config.WAPPCLOUD_TOKEN && config.WAPPCLOUD_API_KEY);

/** Normalise to +<cc><number>; bare 10-digit numbers are assumed Indian. */
export function formatPhone(raw: string): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) d = '91' + d;
  else if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1);
  if (d.length < 11 || d.length > 15) return null;
  return '+' + d;
}

export interface WappTemplate {
  name: string;
  variables: Record<string, string>;
  /** Document-header media WappCloud fetches (e.g. the ack PDF). */
  document?: { url: string; filename: string };
}

// Map a queue template + payload to a registered WappCloud template + its
// positional {{n}} variables (and an optional document header). Exported for
// unit tests. Returns null when no approved template covers the queue template
// (the send then fails clearly).
export function templateFor(meta: SendMeta | undefined): WappTemplate | null {
  if (meta?.template === 'portal_otp' && config.WAPPCLOUD_OTP_TEMPLATE) {
    return { name: config.WAPPCLOUD_OTP_TEMPLATE, variables: { '1': String(meta.payload?.otp ?? '') } };
  }
  // Interest credited for a settled payout batch. ncd_interest_final:
  //   {{1}} name  {{2}} amount  {{3}} month  {{4}} date
  if (meta?.template === 'interest_paid') {
    const p = meta.payload ?? {};
    return {
      name: config.WAPPCLOUD_INTEREST_TEMPLATE || 'ncd_interest_final',
      variables: { '1': String(p.name ?? ''), '2': String(p.amount ?? ''), '3': String(p.month ?? ''), '4': String(p.date ?? '') },
    };
  }
  // Acknowledgement once funds are received. ncd_akn: {{1}} name, plus a
  // Document header carrying the ack PDF (WappCloud fetches payload.documentUrl).
  if (meta?.template === 'acknowledgment') {
    const p = meta.payload ?? {};
    const tpl: WappTemplate = {
      name: config.WAPPCLOUD_ACK_TEMPLATE || 'ncd_akn',
      variables: { '1': String(p.name ?? '') },
    };
    if (p.documentUrl) tpl.document = { url: String(p.documentUrl), filename: String(p.documentName ?? 'Acknowledgment.pdf') };
    return tpl;
  }
  return null;
}

export function wappcloudProvider(): NotifyProvider {
  return {
    async send(to, _subject, _body, meta) {
      if (!wappcloudConfigured()) return { ok: false, error: 'wappcloud: not configured' };
      const tpl = templateFor(meta);
      if (!tpl) return { ok: false, error: `wappcloud: no approved WhatsApp template for '${meta?.template ?? 'unknown'}'` };
      const override = config.WHATSAPP_TEST_PHONE ? formatPhone(config.WHATSAPP_TEST_PHONE) : null;
      const contact = override || formatPhone(to);
      if (!contact) return { ok: false, error: `wappcloud: no valid phone (got "${to}")` };
      if (override) console.warn(`[wappcloud] TEST MODE — message for ${to} redirected to ${override}`);

      // WappCloud message: template name, optional Document header (fetched from
      // the URL), optional {{n}} body variables.
      const message: Record<string, unknown> = { template_name: tpl.name };
      if (tpl.document) message.header = { type: 'document', url: tpl.document.url, filename: tpl.document.filename };
      if (Object.keys(tpl.variables).length) message.body = { variables: tpl.variables };

      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 15000);
      try {
        const r = await fetch(endpoint(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.WAPPCLOUD_TOKEN}`,
            'x-api-key': config.WAPPCLOUD_API_KEY!,
          },
          body: JSON.stringify({ contact_number: contact, message }),
          signal: ctrl.signal,
        });
        const text = await r.text().catch(() => '');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* keep raw text for errors */ }
        if (!r.ok || (json && json.success === false)) {
          return { ok: false, error: `wappcloud: send failed (${r.status}): ${text.slice(0, 300)}` };
        }
        return { ok: true, messageId: json?.data?.message_uid ?? undefined };
      } catch (e) {
        return { ok: false, error: `wappcloud: ${(e as Error).message}` };
      } finally {
        clearTimeout(tid);
      }
    },
  };
}
