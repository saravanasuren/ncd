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

const SEGMENT_BYS = new Set<book.SegmentBy>(['series', 'customer', 'district', 'agent', 'staff', 'branch', 'lockerhub', 'dhanamfin']);

// Grouped explorer: one summary row per dimension value, each expandable to its
// individual investments (see book.segmentGrouped). The flat book.* functions
// stay in use by the Excel export.
reportsRouter.get('/segments/:by', requirePermission('reports:download', 'dashboard:drilldown'),
  asyncHandler(async (req, res) => {
    const by = req.params.by as book.SegmentBy;
    if (!SEGMENT_BYS.has(by)) throw errors.badRequest('Unknown segment');
    res.json({ by, groups: await book.segmentGrouped(getDb(), req.user!, by, filtersFromQuery(req.query)) });
  }));

reportsRouter.get('/ncd-book.xlsx', requirePermission('reports:download'),
  asyncHandler(async (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="dhanam-ncd-book.xlsx"');
    // Streams the workbook straight to the response (bounded memory) and ends it.
    await buildNcdBook(res, getDb(), req.user!, filtersFromQuery(req.query));
  }));

reportsRouter.get('/soa/:customerId.pdf', requirePermission('reports:download', 'customers:read'),
  asyncHandler(async (req, res) => {
    const { assertCustomerVisible } = await import('../../lib/visibility.js');
    await assertCustomerVisible(getDb(), req.user!, Number(req.params.customerId));
    const { soaPdf } = await import('./documents.js');
    const buf = await soaPdf(getDb(), Number(req.params.customerId));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="soa-${req.params.customerId}.pdf"`);
    res.end(buf);
  }));

// Staff-facing bond certificate / allotment letter for one application.
reportsRouter.get('/bond/:applicationId.pdf', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const { assertApplicationVisible } = await import('../../lib/visibility.js');
    await assertApplicationVisible(getDb(), req.user!, Number(req.params.applicationId));
    const { bondCertificatePdf } = await import('./documents.js');
    const buf = await bondCertificatePdf(getDb(), Number(req.params.applicationId));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bond-${req.params.applicationId}.pdf"`);
    res.end(buf);
  }));
reportsRouter.get('/allotment/:applicationId.pdf', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const { assertApplicationVisible } = await import('../../lib/visibility.js');
    await assertApplicationVisible(getDb(), req.user!, Number(req.params.applicationId));
    const { allotmentLetterPdf } = await import('./documents.js');
    const buf = await allotmentLetterPdf(getDb(), Number(req.params.applicationId));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="allotment-${req.params.applicationId}.pdf"`);
    res.end(buf);
  }));

// 26Q quarterly TDS filing annexure. :quarter = 'YYYY-Qn'.
reportsRouter.get('/tds-26q/:quarter.xlsx', requirePermission('reports:download'),
  asyncHandler(async (req, res) => {
    const { tds26q } = await import('./documents.js');
    const buf = await tds26q(getDb(), String(req.params.quarter));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="26Q-${req.params.quarter}.xlsx"`);
    res.end(buf);
  }));

reportsRouter.get('/tds/:yyyymm.xlsx', requirePermission('reports:download'),
  asyncHandler(async (req, res) => {
    const { tdsReport } = await import('./documents.js');
    const buf = await tdsReport(getDb(), req.params.yyyymm!);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tds-${req.params.yyyymm}.xlsx"`);
    res.end(buf);
  }));

reportsRouter.get('/dump.xlsx', requirePermission('imports:run', 'settings:manage'),
  asyncHandler(async (_req, res) => {
    const { dumpXlsx } = await import('./documents.js');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="dhanam-dump.xlsx"');
    await dumpXlsx(res, getDb()); // streams + ends the response
  }));
