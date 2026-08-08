/** TDS threshold routes. Importing the service also registers the
 *  tds_threshold approval handlers at boot (static, like the locker waivers). */
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const tdsRouter = Router();

// Run the detection now (nightly cron does this on its own). Admin/CXO.
tdsRouter.post('/scan', requirePermission('approvals:check-premature'),
  asyncHandler(async (req, res) => res.json(await s.scanTdsThreshold(getDb(), req.user!))));
