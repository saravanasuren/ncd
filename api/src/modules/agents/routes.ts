/** Agents admin routes + payee search for the referred-by dropdown. */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const agentsRouter = Router();

agentsRouter.get('/', requirePermission('agents:manage'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.listAgents(getDb()) })));

const createSchema = z.object({
  full_name: z.string().min(1),
  agent_code: z.string().max(20).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  user_id: z.number().nullable().optional(),
  bank_name: z.string().optional(),
  account_number: z.string().optional(),
  ifsc: z.string().optional(),
});

agentsRouter.post('/', requirePermission('agents:manage'),
  asyncHandler(async (req, res) => res.status(201).json(await s.createAgent(getDb(), req.user!, createSchema.parse(req.body)))));

// Update accepts explicit nulls — the edit form clears a field by sending null
// (createSchema's .optional() alone would reject it).
const updateSchema = createSchema.partial().extend({
  is_active: z.boolean().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  bank_name: z.string().nullable().optional(),
  account_number: z.string().nullable().optional(),
  ifsc: z.string().nullable().optional(),
});

agentsRouter.put('/:id', requirePermission('agents:manage'),
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body);
    await s.updateAgent(getDb(), req.user!, Number(req.params.id), input);
    res.json({ ok: true });
  }));

// Referred-by dropdown: staff enrolling a customer search payees by code/name.
agentsRouter.get('/payee-search', requirePermission('customers:create', 'leads:create'),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    if (q.trim().length < 2) return res.json({ rows: [] });
    res.json({ rows: await s.searchPayees(getDb(), q) });
  }));
