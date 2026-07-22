/**
 * Background Verification routes (spec §5). Reading + inline fixing sit on the
 * normal customer permissions (the grid is scope-filtered, so a branch staffer
 * only ever sees their own book); marking KYC verified stays on the narrower
 * `kyc:verify` — the step that unlocks downstream processing.
 *
 * Document upload/download deliberately reuse the existing customer document
 * endpoints (`POST/GET /api/customers/:id/documents…`) rather than duplicating
 * them here.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const bgvRouter = Router();

bgvRouter.get('/', requirePermission('customers:read'),
  asyncHandler(async (req, res) => res.json(await s.grid(getDb(), req.user!, {
    q: req.query.q ? String(req.query.q) : undefined,
    seriesId: req.query.series_id ? Number(req.query.series_id) : undefined,
    kycStatus: req.query.kyc_status ? String(req.query.kyc_status) : undefined,
  }))));

bgvRouter.patch('/:customerId/fix-field', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    const b = z.object({ field: z.string().min(1), value: z.string() }).parse(req.body ?? {});
    res.json(await s.fixField(getDb(), req.user!, Number(req.params.customerId), b.field, b.value));
  }));

bgvRouter.post('/:customerId/mark-verified', requirePermission('kyc:verify'),
  asyncHandler(async (req, res) => res.json(await s.markVerified(getDb(), req.user!, Number(req.params.customerId)))));
