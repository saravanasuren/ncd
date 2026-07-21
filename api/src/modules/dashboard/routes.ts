/** Dashboard routes (docs/04 §2) — read-only, scoped. */
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';
import type { BookFilters } from '../reports/book.js';

export const dashboardRouter = Router();

function filtersFromQuery(q: Record<string, unknown>): BookFilters {
  return {
    from: q.from as string,
    to: q.to as string,
    seriesIds: q.series ? String(q.series).split(',').map(Number) : undefined,
    districts: q.districts ? String(q.districts).split(',') : undefined,
    status: (q.status as BookFilters['status']) ?? undefined,
  };
}

dashboardRouter.get('/overview', requirePermission('dashboard:view'),
  asyncHandler(async (req, res) => res.json(await s.overview(getDb(), req.user!, filtersFromQuery(req.query)))));

dashboardRouter.get('/monthly-redemptions', requirePermission('dashboard:view'),
  asyncHandler(async (req, res) => res.json({ rows: await s.monthlyRedemptions(getDb(), req.user!) })));

dashboardRouter.get('/search', requirePermission('dashboard:view', 'customers:read'),
  asyncHandler(async (req, res) => res.json(await s.search(getDb(), req.user!, String(req.query.q ?? '')))));

dashboardRouter.get('/drill/:widget', requirePermission('dashboard:drilldown'),
  asyncHandler(async (req, res) => res.json(await s.drill(getDb(), req.user!, req.params.widget!, filtersFromQuery(req.query), String(req.query.param ?? '')))));

// Enroller (branch-staff user or agent) performance — opened from search.
dashboardRouter.get('/person/:type/:id', requirePermission('dashboard:drilldown'),
  asyncHandler(async (req, res) => {
    const type = req.params.type === 'agent' ? 'agent' : 'staff';
    res.json(await s.personPerformance(getDb(), req.user!, type, Number(req.params.id)));
  }));
