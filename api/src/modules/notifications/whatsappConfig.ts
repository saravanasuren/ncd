/**
 * Resolve the per-type WhatsApp send config (owner 2026-08-25) from Settings,
 * with env then hardcoded-default fallback so a blank/missing setting never stops
 * a send. Turns a queued message (type + payload) into the concrete template name,
 * {{n}} variable values, optional document header, and test-phone redirect the
 * WappCloud provider needs — see packages/shared/src/whatsapp.ts for the registry.
 */
import { WHATSAPP_TYPES, whatsappSettingKey, defaultWhatsappConfig, WHATSAPP_TEST_PHONE_KEY, type WhatsappTypeConfig } from '@new-wealth/shared';
import { config } from '../../config.js';

const TYPE_BY_KEY = new Map(WHATSAPP_TYPES.map((d) => [d.type, d]));

// Env fallback for the template NAME per type — keeps the old SSM knobs working
// until a Settings value is entered, so this change deploys without a redeploy dance.
const ENV_NAME: Record<string, string | undefined> = {
  acknowledgment: config.WAPPCLOUD_ACK_TEMPLATE,
  interest_paid: config.WAPPCLOUD_INTEREST_TEMPLATE,
  portal_otp: config.WAPPCLOUD_OTP_TEMPLATE,
  locker_booked: config.WAPPCLOUD_LOCKER_TEMPLATE,
};

export interface ResolvedWhatsapp {
  enabled: boolean;
  name: string;
  variables: Record<string, string>;
  document?: { url: string; filename: string };
  testPhone: string | null;
}

/** null when the queue template is not a known WhatsApp type (caller falls back). */
export function resolveWhatsapp(
  settings: Record<string, unknown>,
  template: string,
  payload: Record<string, unknown>,
): ResolvedWhatsapp | null {
  const def = TYPE_BY_KEY.get(template);
  if (!def) return null;

  const stored = settings[whatsappSettingKey(template)] as Partial<WhatsappTypeConfig> | undefined;
  const cfg = { ...defaultWhatsappConfig(def), ...(stored ?? {}) };

  const name = (cfg.template_name || ENV_NAME[template] || def.defaultTemplateName || '').trim();
  const known = new Set(def.fields.map((f) => f.key));
  const order = Array.isArray(cfg.variables) && cfg.variables.length ? cfg.variables : def.defaultVariables;
  const variables: Record<string, string> = {};
  order.forEach((field, i) => { if (known.has(field)) variables[String(i + 1)] = String(payload[field] ?? ''); });

  const testPhone = (String(settings[WHATSAPP_TEST_PHONE_KEY] ?? '') || config.WHATSAPP_TEST_PHONE || '').trim() || null;
  const res: ResolvedWhatsapp = { enabled: cfg.enabled !== false, name, variables, testPhone };
  if (def.hasDocument && payload.documentUrl) {
    res.document = { url: String(payload.documentUrl), filename: String(payload.documentName ?? 'Document.pdf') };
  }
  return res;
}
