/**
 * Validated environment config (docs/01 §4). In production, secrets are
 * loaded from AWS SSM into process.env BEFORE this runs (see secrets.ts);
 * the same code path validates them here.
 */
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3020),
  DATABASE_URL: z.string().min(1).optional(),
  JWT_ACCESS_SECRET: z.string().min(16).default('dev_access_secret_change_me_16chars'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev_refresh_secret_change_me_16chars'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@dhanam.finance'),
  SEED_ADMIN_PASSWORD: z.string().default('ChangeMe_Dev_123'),
  KYC_PRIMARY_PROVIDER: z.string().default('stub'),
  PAYMENT_PRIMARY_PROVIDER: z.string().default('stub'),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

export const isProd = config.NODE_ENV === 'production';
