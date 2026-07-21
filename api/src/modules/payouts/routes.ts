/** Payout (interest NEFT batch) routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const payoutsRouter = Router();

payoutsRouter.get('/preview', requirePermission('payouts:generate'),
  asyncHandler(async (req, res) => res.json(await s.previewDue(getDb(), String(req.query.date ?? new Date().toISOString().slice(0, 10))))));

// Stateless: pull the sheet for ANY date, as often as you like. Writes nothing.
payoutsRouter.get('/sheet.xlsx', requirePermission('payouts:generate'),
  asyncHandler(async (req, res) => {
    const date = String(req.query.date ?? new Date().toISOString().slice(0, 10));
    const buffer = await s.neftSheetForDate(getDb(), date);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="NEFT-interest-upto-${date}.xlsx"`);
    res.send(buffer);
  }));

payoutsRouter.get('/', requirePermission('payouts:generate'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.listBatches(getDb()) })));

payoutsRouter.post('/', requirePermission('payouts:generate'),
  asyncHandler(async (req, res) => {
    const { payout_date, utr } = z.object({ payout_date: z.string(), utr: z.string().optional() }).parse(req.body);
    res.status(201).json(await s.createInterestBatch(getDb(), req.user!, payout_date, utr));
  }));

payoutsRouter.post('/:id/mark-paid', requirePermission('payouts:mark-paid-manual'),
  asyncHandler(async (req, res) => {
    const { utr } = z.object({ utr: z.string().optional() }).parse(req.body);
    res.json(await s.markBatchPaid(getDb(), req.user!, Number(req.params.id), utr));
  }));

// Explicit staff action: WhatsApp every customer paid in this settled batch
// (approved ncd_interest_final). Kept off the settlement path so hundreds of
// sends never fire as an approval side effect.
payoutsRouter.post('/:id/whatsapp-interest', requirePermission('notifications:admin', 'payouts:mark-paid-manual'),
  asyncHandler(async (req, res) => res.json(await s.notifyInterestOnWhatsapp(getDb(), Number(req.params.id)))));

payoutsRouter.get('/:id/download.xlsx', requirePermission('payouts:generate'),
  asyncHandler(async (req, res) => {
    const { buffer, batchNo } = await s.neftForBatch(getDb(), Number(req.params.id));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="neft-${batchNo}.xlsx"`);
    res.end(buffer);
  }));

payoutsRouter.post('/rows/:scheduleId/mark-failed', requirePermission('payouts:mark-paid-manual'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(2) }).parse(req.body);
    res.json(await s.markRowFailed(getDb(), req.user!, Number(req.params.scheduleId), reason));
  }));
