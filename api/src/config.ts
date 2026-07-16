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
  WHATSAPP_TEST_PHONE: z.string().optional(), // redirects ALL WhatsApp sends while set
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

export const isProd = config.NODE_ENV === 'production';
