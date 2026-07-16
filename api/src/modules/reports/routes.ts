/** Reports routes (docs/04 §2) — segments + the 9-tab Excel export. */
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import { errors } from '../../lib/errors.js';
import * as book from './book.js';
import { buildNcdBook } from './export.js';
import type { BookFilters } from './book.js';

export const reportsRouter = Router();

function filtersFromQuery(q: Record<string, unknown>): BookFilters {
  return {
    from: q.from as string,
    to: q.to as string,
    seriesIds: q.series ? String(q.series).split(',').map(Number) : undefined,
    districts: q.districts ? String(q.districts).split(',') : undefined,
    status: (q.status as BookFilters['status']) ?? undefined,
  };
}

const SEGMENTS = {
  customer: book.customerwise,
  district: book.districtwise,
  agent: book.agentwise,
  staff: book.staffwise,
} as const;

reportsRouter.get('/segments/:by', requirePermission('reports:download', 'dashboard:drilldown'),
  asyncHandler(async (req, res) => {
    const fn = SEGMENTS[req.params.by as keyof typeof SEGMENTS];
    if (!fn) throw errors.badRequest('Unknown segment');
    res.json({ rows: await fn(getDb(), req.user!, filtersFromQuery(req.query)) });
  }));

reportsRouter.get('/ncd-book.xlsx', requirePermission('reports:download'),
  asyncHandler(async (req, res) => {
    const buf = await buildNcdBook(getDb(), req.user!, filtersFromQuery(req.query));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="dhanam-ncd-book.xlsx"');
    res.end(buf);
  }));
