/** Products/masters routes (docs/04 §2). All gated by products:manage
 * except company-profile read (any authed) — mounted under /api. */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const productsRouter = Router();
const manage = requirePermission('products:manage');

// Schemes
productsRouter.get('/schemes', requireAuth, asyncHandler(async (_req, res) => res.json({ rows: await s.listSchemes(getDb()) })));
productsRouter.post('/schemes', manage, asyncHandler(async (req, res) => res.status(201).json(await s.createScheme(getDb(), req.user!, req.body))));
productsRouter.put('/schemes/:id', manage, asyncHandler(async (req, res) => { await s.updateScheme(getDb(), req.user!, Number(req.params.id), req.body); res.json({ ok: true }); }));

// Series
productsRouter.get('/series', requireAuth, asyncHandler(async (_req, res) => res.json({ rows: await s.listSeries(getDb()) })));
productsRouter.post('/series', manage, asyncHandler(async (req, res) => res.status(201).json(await s.createSeries(getDb(), req.user!, req.body))));
productsRouter.post('/series/:id/status', manage, asyncHandler(async (req, res) => {
  const { to } = z.object({ to: z.string() }).parse(req.body);
  await s.setSeriesStatus(getDb(), req.user!, Number(req.params.id), to);
  res.json({ ok: true });
}));
productsRouter.post('/series/:id/isin', manage, asyncHandler(async (req, res) => {
  const { isin } = z.object({ isin: z.string().min(1) }).parse(req.body);
  await s.setSeriesIsin(getDb(), req.user!, Number(req.params.id), isin);
  res.json({ ok: true });
}));

// TDS rules
productsRouter.get('/tds-rules', requireAuth, asyncHandler(async (_req, res) => res.json({ rows: await s.listTdsRules(getDb()) })));
productsRouter.post('/tds-rules', manage, asyncHandler(async (req, res) => res.status(201).json(await s.createTdsRule(getDb(), req.user!, req.body))));

// Banks
productsRouter.get('/banks', requireAuth, asyncHandler(async (_req, res) => res.json({ rows: await s.listBanks(getDb()) })));
productsRouter.post('/banks', manage, asyncHandler(async (req, res) => res.status(201).json(await s.createBank(getDb(), req.user!, req.body))));

// Holidays
productsRouter.get('/holidays', requireAuth, asyncHandler(async (_req, res) => res.json({ rows: await s.listHolidays(getDb()) })));
productsRouter.post('/holidays', manage, asyncHandler(async (req, res) => {
  const { d, label } = z.object({ d: z.string(), label: z.string() }).parse(req.body);
  await s.addHoliday(getDb(), req.user!, d, label);
  res.status(201).json({ ok: true });
}));

// Company profile (singleton)
productsRouter.get('/company-profile', requireAuth, asyncHandler(async (_req, res) => res.json({ profile: await s.getCompanyProfile(getDb()) })));
productsRouter.put('/company-profile', manage, asyncHandler(async (req, res) => { await s.updateCompanyProfile(getDb(), req.user!, req.body); res.json({ ok: true }); }));
