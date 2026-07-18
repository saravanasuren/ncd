/** Users & branches routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as service from './service.js';

export const usersRouter = Router();

usersRouter.get(
  '/',
  requirePermission('users:manage'),
  asyncHandler(async (_req, res) => {
    res.json({ rows: await service.listUsers(getDb()) });
  })
);

usersRouter.get(
  '/branches',
  requirePermission('users:manage'),
  asyncHandler(async (_req, res) => {
    res.json({ rows: await service.listBranches(getDb()) });
  })
);

const createSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1),
  role: z.string(),
  password: z.string().min(8),
  branch_id: z.number().nullable().optional(),
  reports_to_user_id: z.number().nullable().optional(),
  code: z.string().max(20).nullable().optional(),
  is_staff: z.boolean().optional(),
});

usersRouter.post(
  '/',
  requirePermission('users:manage'),
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    res.status(201).json(await service.createUser(getDb(), req.user!, input));
  })
);

const updateSchema = z.object({
  full_name: z.string().min(1).optional(),
  role: z.string().optional(),
  branch_id: z.number().nullable().optional(),
  reports_to_user_id: z.number().nullable().optional(),
  is_active: z.boolean().optional(),
  password: z.string().min(8).optional(),
  code: z.string().max(20).nullable().optional(),
  is_staff: z.boolean().optional(),
});

usersRouter.put(
  '/:id',
  requirePermission('users:manage'),
  asyncHandler(async (req, res) => {
    await service.updateUser(getDb(), req.user!, Number(req.params.id), updateSchema.parse(req.body));
    res.json({ ok: true });
  })
);

usersRouter.put(
  '/:id/branches',
  requirePermission('users:manage'),
  asyncHandler(async (req, res) => {
    const { branchIds } = z.object({ branchIds: z.array(z.number()) }).parse(req.body);
    await service.setUserBranches(getDb(), req.user!, Number(req.params.id), branchIds);
    res.json({ ok: true });
  })
);

usersRouter.delete(
  '/:id',
  requirePermission('users:delete'),
  asyncHandler(async (req, res) => {
    await service.deleteUser(getDb(), req.user!, Number(req.params.id));
    res.json({ ok: true });
  })
);
