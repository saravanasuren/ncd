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

// Dhanamfin app prospects (profile-only customers with no application).
leadsRouter.get('/app-prospects', requirePermission('leads:read'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.listAppProspects(getDb()) })));

const createSchema = z.object({
  full_name: z.string().min(1),
  phone: z.string().optional(),
  place: z.string().optional(),
  district: z.string().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  referred_by_text: z.string().optional(),
  lead_type: z.enum(['ncd', 'locker']).optional(),
  interested_scheme: z.string().optional(),
  locker_size: z.enum(['Medium', 'L', 'XL']).optional(),
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

leadsRouter.get('/:id/notes', requirePermission('leads:read'),
  asyncHandler(async (req, res) => res.json({ rows: await s.listNotes(getDb(), Number(req.params.id)) })));

leadsRouter.get('/duplicate-check', requirePermission('leads:read'),
  asyncHandler(async (req, res) => res.json(await s.duplicateCheck(getDb(), String(req.query.phone ?? '')))));

// Conversion = link the lead to a customer created through the full customer
// form (the wizard, name pre-filled). No amount/series here anymore.
leadsRouter.post('/:id/link-customer', requirePermission('leads:convert'),
  asyncHandler(async (req, res) => {
    const { customer_id } = z.object({ customer_id: z.number().int().positive() }).parse(req.body);
    res.status(201).json(await s.linkLeadToCustomer(getDb(), req.user!, Number(req.params.id), customer_id));
  }));
