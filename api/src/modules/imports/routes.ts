/** Import routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import { runBackdatedImport } from './service.js';

export const importsRouter = Router();

importsRouter.post('/backdated', requirePermission('imports:run'),
  asyncHandler(async (req, res) => {
    const { rows } = z.object({
      rows: z.array(z.object({
        full_name: z.string().min(1), pan: z.string().optional(), phone: z.string().optional(), district: z.string().optional(),
        series_code: z.string(), scheme_code: z.string(), amount: z.number().positive(), allotment_date: z.string(),
      })).min(1),
    }).parse(req.body);
    res.status(201).json(await runBackdatedImport(getDb(), req.user!, rows));
  }));
