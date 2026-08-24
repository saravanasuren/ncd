/** Settings routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import * as service from './service.js';
import { sendWhatsappTest } from '../notifications/service.js';

export const settingsRouter = Router();

// Send a sample WhatsApp of one message type to a chosen number — the per-template
// "send test" (owner 2026-08-25). Admin-gated, same as editing the config.
const testSchema = z.object({ type: z.string(), phone: z.string() });
settingsRouter.post(
  '/whatsapp/test',
  requirePermission('settings:manage'),
  asyncHandler(async (req, res) => {
    const { type, phone } = testSchema.parse(req.body);
    res.json(await sendWhatsappTest(getDb(), type, phone));
  })
);

// Safe, non-secret vocabularies the staff UI needs (lead form dropdowns etc.).
// Any authed user may read these; the full registry stays admin-gated below.
const UI_CONFIG_KEYS = [
  'customers.lead_sources', 'customers.lead_statuses', 'customers.collection_methods',
  'customers.lead_categories', 'customers.lead_referred_by', 'customers.lead_interested_schemes',
  'redemption.premature_penalty_waiver_enabled',
] as const;
settingsRouter.get(
  '/ui-config',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const all = await service.listSettings(getDb());
    const flat = Object.values(all).flat();
    const values: Record<string, unknown> = {};
    for (const k of UI_CONFIG_KEYS) values[k] = flat.find((s) => s.key === k)?.value ?? null;
    res.json({ values });
  })
);

// Read requires either full settings management or workflow-config rights.
settingsRouter.get(
  '/',
  requirePermission('settings:manage', 'settings:workflow-config'),
  asyncHandler(async (_req, res) => {
    res.json({ groups: await service.listSettings(getDb()) });
  })
);

const putSchema = z.object({ value: z.unknown() });

settingsRouter.put(
  '/:key',
  requirePermission('settings:manage', 'settings:workflow-config'),
  asyncHandler(async (req, res) => {
    const { value } = putSchema.parse(req.body);
    const updated = await service.updateSetting(getDb(), req.user!, req.params.key!, value);
    res.json({ setting: updated });
  })
);
