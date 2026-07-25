/** Escrow reconciliation routes (inbound subscription money). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const escrowRouter = Router();
const perm = requirePermission('escrow:reconcile');

/** Dashboard tiles + drill-down breakup. Visible to anyone who can reconcile. */
escrowRouter.get('/summary', perm, asyncHandler(async (_req, res) => res.json(await s.escrowSummary(getDb()))));

escrowRouter.get('/statements', perm, asyncHandler(async (_req, res) => res.json({ rows: await s.listStatements(getDb()) })));

escrowRouter.get('/lines', perm, asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const statementId = req.query.statement_id ? Number(req.query.statement_id) : undefined;
  res.json({ rows: await s.listLines(getDb(), { status, statementId }) });
}));

/** Upload an SBI escrow statement (base64 of the xls/xlsx/csv). Parses, stores,
 *  proposes matches. Idempotent — re-uploading an overlapping window is a no-op. */
escrowRouter.post('/statements', perm, asyncHandler(async (req, res) => {
  const b = z.object({ filename: z.string().min(1), data_base64: z.string().min(1) }).parse(req.body);
  const buf = Buffer.from(b.data_base64, 'base64');
  res.status(201).json(await s.uploadStatement(getDb(), req.user!, b.filename, buf));
}));

escrowRouter.post('/lines/:id/confirm', perm, asyncHandler(async (req, res) => res.json(await s.confirmLine(getDb(), req.user!, Number(req.params.id)))));

escrowRouter.post('/lines/:id/assign', perm, asyncHandler(async (req, res) => {
  const b = z.object({ customer_id: z.number().int().positive() }).parse(req.body);
  res.json(await s.assignLine(getDb(), req.user!, Number(req.params.id), b.customer_id));
}));

escrowRouter.post('/lines/:id/ignore', perm, asyncHandler(async (req, res) => {
  const b = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
  res.json(await s.ignoreLine(getDb(), req.user!, Number(req.params.id), b.reason));
}));
