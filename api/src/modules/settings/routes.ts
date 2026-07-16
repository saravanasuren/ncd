/** Settings routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as service from './service.js';

export const settingsRouter = Router();

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
