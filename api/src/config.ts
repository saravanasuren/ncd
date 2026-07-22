/**
 * Validated environment config (docs/01 §4). In production, secrets are
 * loaded from AWS SSM into process.env BEFORE this runs (see secrets.ts);
 * the same code path validates them here.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Resolve api/.env relative to this module, not process.cwd() — CLIs run from
// the repo root missed it and silently fell back to NODE_ENV=development.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3030),
  DATABASE_URL: z.string().min(1).optional(),
  JWT_ACCESS_SECRET: z.string().min(16).default('dev_access_secret_change_me_16chars'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev_refresh_secret_change_me_16chars'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@dhanam.finance'),
  SEED_ADMIN_PASSWORD: z.string().default('ChangeMe_Dev_123'),
  KYC_PRIMARY_PROVIDER: z.string().default('stub'),
  PAYMENT_PRIMARY_PROVIDER: z.string().default('stub'),
  LOCKERHUB_INTEGRATION_KEY: z.string().default('dev-integration-key'),

  // ── Live provider credentials (SSM /dhanam/newwealth/*; docs/08) ──
  // Decentro (PAN verify + BAV-v3 penny drop). All optional: the adapter
  // falls back to the stub when creds are missing.
  DECENTRO_CLIENT_ID: z.string().optional(),
  DECENTRO_CLIENT_SECRET: z.string().optional(),
  DECENTRO_BASE: z.string().optional(),
  DECENTRO_MASTER_CONSUMER_URN: z.string().optional(),
  DECENTRO_VBA_CONSUMER_URN: z.string().optional(),
  DECENTRO_VBA_VALIDATION_TYPE: z.string().optional(),
  // Notifications.
  NOTIFICATIONS_PROVIDER: z.string().default('stub'), // 'stub' | 'ses'
  SES_REGION: z.string().default('ap-south-1'),
  NOTIFICATIONS_FROM_EMAIL: z.string().default('contact@dhanam.finance'),
  NOTIFICATIONS_FROM_NAME: z.string().default('Dhanam Investment and Finance'),
  NOTIFICATIONS_REPLY_TO: z.string().default('contact@dhanam.finance'),
  // WappCloud WhatsApp (approved templates only).
  WAPPCLOUD_TOKEN: z.string().optional(),
  WAPPCLOUD_API_KEY: z.string().optional(),
  WAPPCLOUD_ENDPOINT: z.string().optional(),
  WAPPCLOUD_OTP_TEMPLATE: z.string().optional(),
  WAPPCLOUD_INTEREST_TEMPLATE: z.string().optional(), // approved interest-paid template (default 'ncd_interest_final')
  WAPPCLOUD_ACK_TEMPLATE: z.string().optional(),      // approved acknowledgement template (default 'ncd_akn')
  WHATSAPP_TEST_PHONE: z.string().optional(), // redirects ALL WhatsApp sends while set
  // Public origin WappCloud fetches WhatsApp document headers from (e.g. the ack
  // PDF). Required for the WhatsApp acknowledgement; no default — set in SSM.
  PUBLIC_BASE_URL: z.string().optional(),
  // ── LockerHub outbound (cutover-gated; see ops/CUTOVER-LOCKERHUB.md) ──
  // Agent-event webhooks fire ONLY when both URL + secret are set in SSM.
  LOCKERHUB_WEBHOOK_URL: z.string().optional(),
  LOCKERHUB_WEBHOOK_SECRET: z.string().optional(),
  // Customer/subscription event webhook (NCD_INTEGRATION_CONTRACT.md). Fires
  // ONLY when this URL is set; auth reuses the shared LOCKERHUB_INTEGRATION_KEY
  // as an outbound X-Integration-Key. Contract target:
  //   https://lockers.dhanamfinance.com/api/integration/wealth/webhook
  LOCKERHUB_EVENT_WEBHOOK_URL: z.string().optional(),
  // Daily reconciliation cron runs ONLY when explicitly enabled.
  LOCKERHUB_RECONCILIATION_ENABLED: z.string().default('false'),
  LOCKERHUB_DB_PATH: z.string().default('/home/ubuntu/LockerHub/data/lockerhub.db'),
  // Outbound locker-enrollment (contract Part A). NCD staff enroll a customer
  // for a LOCKER by calling LockerHub. Base = …/api/integration/v1. The client
  // is inert unless LOCKERHUB_API_URL is set; auth = LOCKERHUB_API_KEY, falling
  // back to the shared LOCKERHUB_INTEGRATION_KEY.
  LOCKERHUB_API_URL: z.string().optional(),
  LOCKERHUB_API_KEY: z.string().optional(),
  // ── Payments (docs/08 §2). Collection is LockerHub/Easebuzz-side; ncd
  // receives funded payments via the façade. These wire the adapter selector
  // + webhook verification. Stub default. ──
  CASHFREE_APP_ID: z.string().optional(),
  CASHFREE_SECRET_KEY: z.string().optional(),
  CASHFREE_BASE: z.string().optional(),
  EASEBUZZ_KEY: z.string().optional(),
  EASEBUZZ_SALT: z.string().optional(),
  EASEBUZZ_BASE: z.string().optional(),
  // ── Digio eSign (docs/08 §2). eSign is off ncd's critical path (records
  // esigned_at). All optional: stub when creds absent. ──
  DIGIO_CLIENT_ID: z.string().optional(),
  DIGIO_CLIENT_SECRET: z.string().optional(),
  DIGIO_BASE: z.string().optional(),
  DIGIO_WEBHOOK_SECRET: z.string().optional(),
  // eSign auto-completion: poll Digio for outstanding sign requests so a signed
  // document flips to eSigned on its own (no webhook, no manual "Mark eSigned").
  // ON by default; set to 'false' in SSM to disable. No-ops unless DIGIO_* creds
  // are present. Interval in seconds (owner asked for ~15s).
  DIGIO_POLLER_ENABLED: z.string().default('true'),
  DIGIO_POLL_SECONDS: z.coerce.number().default(15),
  // ── SharePoint (Graph) — offsite backup copy (docs/08 §2) ──
  SHAREPOINT_TENANT_ID: z.string().optional(),
  SHAREPOINT_CLIENT_ID: z.string().optional(),
  SHAREPOINT_CLIENT_SECRET: z.string().optional(),
  SHAREPOINT_BACKUP_DRIVE_ID: z.string().optional(),
  SHAREPOINT_BACKUP_FOLDER: z.string().default('NewWealthBackups'),
  BACKUP_DIR: z.string().default('/var/backups/dhanam-newwealth'),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

export const isProd = config.NODE_ENV === 'production';

// Fail CLOSED in production: the schema supplies dev fallbacks so local dev and
// tests boot with zero setup, but if a real secret is ever missing/misnamed in
// SSM the app must NOT boot signing JWTs (or accepting the integration key) with
// a publicly-known default — that would let anyone forge a super_admin session.
if (isProd) {
  // Only RUNTIME security secrets fail the boot. SEED_ADMIN_PASSWORD is used
  // once at seed time (not per request), so it must NOT block a normal boot.
  const insecureDefaults: Record<string, string> = {
    JWT_ACCESS_SECRET: 'dev_access_secret_change_me_16chars',
    JWT_REFRESH_SECRET: 'dev_refresh_secret_change_me_16chars',
    LOCKERHUB_INTEGRATION_KEY: 'dev-integration-key',
  };
  const stillDefault = Object.entries(insecureDefaults)
    .filter(([k, def]) => (config as Record<string, unknown>)[k] === def)
    .map(([k]) => k);
  if (stillDefault.length) {
    throw new Error(
      `Refusing to boot in production with default secret(s): ${stillDefault.join(', ')}. ` +
      `Set them in SSM (/dhanam/newwealth/*) before starting.`,
    );
  }
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required in production.');
}
