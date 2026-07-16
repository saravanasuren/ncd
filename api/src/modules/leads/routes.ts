/** Leads routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const leadsRouter = Router();

leadsRouter.get('/', requirePermission('leads:read'),
  asyncHandler(async (req, res) => res.json({ rows: await s.listLeads(getDb(), req.user!) })));

const createSchema = z.object({
  full_name: z.string().min(1),
  phone: z.string().optional(),
  place: z.string().optional(),
  district: z.string().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  referred_by_text: z.string().optional(),
  interested_scheme: z.string().optional(),
  expected_amount: z.number().optional(),
  follow_up_date: z.string().optional(),
  status: z.string().optional(),
  notes: z.string().optional(),
});

leadsRouter.post('/', requirePermission('leads:create'),
  asyncHandler(async (req, res) => res.status(201).json(await s.createLead(getDb(), req.user!, createSchema.parse(req.body)))));

leadsRouter.put('/:id', requirePermission('leads:update'),
  asyncHandler(async (req, res) => { await s.updateLead(getDb(), req.user!, Number(req.params.id), createSchema.partial().parse(req.body)); res.json({ ok: true }); }));

leadsRouter.post('/:id/notes', requirePermission('leads:update'),
  asyncHandler(async (req, res) => { const { note } = z.object({ note: z.string().min(1) }).parse(req.body); await s.addNote(getDb(), req.user!, Number(req.params.id), note); res.status(201).json({ ok: true }); }));

leadsRouter.get('/duplicate-check', requirePermission('leads:read'),
  asyncHandler(async (req, res) => res.json(await s.duplicateCheck(getDb(), String(req.query.phone ?? '')))));

leadsRouter.post('/:id/convert', requirePermission('leads:convert'),
  asyncHandler(async (req, res) => {
    const { confirmed_amount, confirmed_series_id } = z.object({ confirmed_amount: z.number(), confirmed_series_id: z.number() }).parse(req.body);
    res.status(201).json(await s.convertLead(getDb(), req.user!, Number(req.params.id), confirmed_amount, confirmed_series_id));
  }));
