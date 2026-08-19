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

// Subordinate Bond products (owner 2026-08-10) — the sub-bond equivalent of a
// scheme, since a subordinate bond belongs to no series. Readable by any signed
// -in user (enrolment needs the list); managed under the same products:manage
// permission as schemes, so no new permission has to be granted before the
// feature is reachable.
productsRouter.get('/sob-products', requireAuth, asyncHandler(async (_req, res) => res.json({ rows: await s.listSobProducts(getDb()) })));
productsRouter.post('/sob-products', manage, asyncHandler(async (req, res) => res.status(201).json(await s.createSobProduct(getDb(), req.user!, req.body))));
productsRouter.put('/sob-products/:id', manage, asyncHandler(async (req, res) => { await s.updateSobProduct(getDb(), req.user!, Number(req.params.id), req.body); res.json({ ok: true }); }));

// Series
productsRouter.get('/series', requireAuth, asyncHandler(async (_req, res) => res.json({ rows: await s.listSeries(getDb()) })));
productsRouter.post('/series', manage, asyncHandler(async (req, res) => res.status(201).json(await s.createSeries(getDb(), req.user!, req.body))));
// Edit a series → approval (owner 2026-08-19). Status and ISIN keep their own
// dedicated actions below; this is the record itself.
productsRouter.put('/series/:id', manage, asyncHandler(async (req, res) => {
  const b = z.object({
    code: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    face_value: z.number().nullable().optional(),
    deemed_date: z.string().nullable().optional(),
  }).parse(req.body ?? {});
  res.json(await s.requestSeriesChange(getDb(), req.user!, Number(req.params.id), b));
}));
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
// Locker pricing — NCD-owned deposit + rent per size (UI-configurable).
productsRouter.get('/locker-pricing', requireAuth, asyncHandler(async (_req, res) => res.json({ rows: await s.listLockerPricing(getDb()) })));
productsRouter.put('/locker-pricing/:size', manage, asyncHandler(async (req, res) => {
  await s.upsertLockerPricing(getDb(), req.user!, String(req.params.size), req.body);
  res.json({ ok: true });
}));

productsRouter.get('/holidays', requireAuth, asyncHandler(async (_req, res) => res.json({ rows: await s.listHolidays(getDb()) })));
productsRouter.post('/holidays', manage, asyncHandler(async (req, res) => {
  const { d, label } = z.object({ d: z.string(), label: z.string() }).parse(req.body);
  await s.addHoliday(getDb(), req.user!, d, label);
  res.status(201).json({ ok: true });
}));

// Company profile (singleton)
productsRouter.get('/company-profile', requireAuth, asyncHandler(async (_req, res) => res.json({ profile: await s.getCompanyProfile(getDb()) })));
productsRouter.put('/company-profile', manage, asyncHandler(async (req, res) => { await s.updateCompanyProfile(getDb(), req.user!, req.body); res.json({ ok: true }); }));

// Bond certificate director signatures — 3 fixed slots (index 0,1,2), matching
// forms/bond.ts's DIRECTORS order. Read is any-authed (same as the rest of the
// certificate's data); upload/delete need products:manage.
productsRouter.get('/company-profile/bond-signature/:index', requireAuth, asyncHandler(async (req, res) => {
  const index = Number(req.params.index);
  const sig = await s.getBondSignature(getDb(), index);
  if (!sig) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No signature uploaded for this slot' } }); return; }
  res.setHeader('Content-Type', sig.mime);
  res.send(sig.buffer);
}));
productsRouter.post('/company-profile/bond-signature/:index', manage, asyncHandler(async (req, res) => {
  const b = z.object({ filename: z.string().min(1), data_base64: z.string().min(1) }).parse(req.body);
  res.status(201).json(await s.uploadBondSignature(getDb(), req.user!, Number(req.params.index), b.filename, b.data_base64));
}));
productsRouter.delete('/company-profile/bond-signature/:index', manage, asyncHandler(async (req, res) =>
  res.json(await s.deleteBondSignature(getDb(), req.user!, Number(req.params.index)))));

// Acknowledgment authorised-signatory (CEO) signature — single slot, printed on
// the receipt acknowledgment. Same auth model as the bond signatures above.
productsRouter.get('/company-profile/ack-signature', requireAuth, asyncHandler(async (_req, res) => {
  const sig = await s.getAckSignature(getDb());
  if (!sig) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No acknowledgment signature uploaded' } }); return; }
  res.setHeader('Content-Type', sig.mime);
  res.send(sig.buffer);
}));
productsRouter.post('/company-profile/ack-signature', manage, asyncHandler(async (req, res) => {
  const b = z.object({ filename: z.string().min(1), data_base64: z.string().min(1) }).parse(req.body);
  res.status(201).json(await s.uploadAckSignature(getDb(), req.user!, b.filename, b.data_base64));
}));
productsRouter.delete('/company-profile/ack-signature', manage, asyncHandler(async (req, res) =>
  res.json(await s.deleteAckSignature(getDb(), req.user!))));
