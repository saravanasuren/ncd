/** Reports routes (docs/04 §2) — segments + the 9-tab Excel export. */
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission, fileTokenOr } from '../../middleware/auth.js';
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
// Everything started but not finished, in one place. Read-only, NCD-owned data
// only — it must answer even when LockerHub is down (see reports/outstanding.ts).
// customers:read rather than reports:download: this is an operational worklist
// staff act on, not a report they export.
reportsRouter.get('/outstanding', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const { outstandingItems } = await import('./outstanding.js');
    const customerId = req.query.customer_id ? Number(req.query.customer_id) : undefined;
    res.json({ rows: await outstandingItems(getDb(), req.user!, customerId) });
  }));

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

// The SIGNED application returned by Digio after eSign (stored at completion).
// 404 until the customer has actually signed and the copy was fetched.
reportsRouter.get('/esigned/:applicationId.pdf', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const { assertApplicationVisible } = await import('../../lib/visibility.js');
    const appId = Number(req.params.applicationId);
    await assertApplicationVisible(getDb(), req.user!, appId);
    const row = (await getDb().query<{ esigned_pdf_path: string | null }>(
      'SELECT esigned_pdf_path FROM applications WHERE id = $1', [appId])).rows[0];
    if (!row?.esigned_pdf_path) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No signed document yet for this application' } });
      return;
    }
    const { readStored } = await import('../../lib/storage.js');
    const buf = readStored(row.esigned_pdf_path);
    if (!buf) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Signed document file is missing on disk' } });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="signed-application-${appId}.pdf"`);
    res.end(buf);
  }));

// Staff-facing bond certificate / allotment letter for one application.
reportsRouter.get('/bond/:applicationId.pdf', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const { assertApplicationVisible } = await import('../../lib/visibility.js');
    await assertApplicationVisible(getDb(), req.user!, Number(req.params.applicationId));
    const { bondCertificatePdf } = await import('./forms/bond.js');
    const buf = await bondCertificatePdf(getDb(), Number(req.params.applicationId));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bond-${req.params.applicationId}.pdf"`);
    res.end(buf);
  }));
// The consolidated "filing bond" — one certificate covering all of a customer's
// issued investments in a series (total value, total units, + the breakup).
reportsRouter.get('/consolidated-bond/:customerId/:seriesId.pdf', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const { assertCustomerVisible } = await import('../../lib/visibility.js');
    await assertCustomerVisible(getDb(), req.user!, Number(req.params.customerId));
    const { consolidatedBondCertificatePdf } = await import('./forms/bond.js');
    const buf = await consolidatedBondCertificatePdf(getDb(), Number(req.params.customerId), Number(req.params.seriesId));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="consolidated-bond-${req.params.customerId}-${req.params.seriesId}.pdf"`);
    res.end(buf);
  }));
// EVERY customer's consolidated bond for a series, as one printable file (owner
// 2026-08-28). Gated on allotments:execute, not customers:read: this is the
// series-wide operation from the Allotments page, and it MINTS a certificate
// number for every customer who lacks one — a heavier action than reading one
// customer's document.
reportsRouter.get('/consolidated-bonds/series/:seriesId.pdf', requirePermission('allotments:execute'),
  asyncHandler(async (req, res) => {
    const seriesId = Number(req.params.seriesId);
    const { seriesCustomers } = await import('../allotments/service.js');
    const { rows, series } = await seriesCustomers(getDb(), seriesId);
    if (!rows.length) throw errors.notFound('No issued investments in this series');
    const ids = (rows as Array<Record<string, unknown>>).map((r) => Number(r.customer_id));
    const { consolidatedBondsForSeriesPdf } = await import('./forms/bond.js');
    const buf = await consolidatedBondsForSeriesPdf(getDb(), seriesId, ids);
    const safe = String(series.code || seriesId).replace(/[^A-Za-z0-9_-]+/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}-bonds.pdf"`);
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
// Accepts a `?vt=` file token so WappCloud can fetch the ack PDF for the
// WhatsApp document header; a valid token skips the session visibility check.
reportsRouter.get('/acknowledgment/:applicationId.pdf', fileTokenOr('acknowledgment', 'customers:read'),
  asyncHandler(async (req, res) => {
    if (!req.fileToken) {
      const { assertApplicationVisible } = await import('../../lib/visibility.js');
      await assertApplicationVisible(getDb(), req.user!, Number(req.params.applicationId));
    }
    const { acknowledgmentPdf } = await import('./forms/acknowledgment.js');
    const buf = await acknowledgmentPdf(getDb(), Number(req.params.applicationId));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="acknowledgment-${req.params.applicationId}.pdf"`);
    res.end(buf);
  }));
reportsRouter.get('/application-form/:applicationId.pdf', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const { assertApplicationVisible } = await import('../../lib/visibility.js');
    await assertApplicationVisible(getDb(), req.user!, Number(req.params.applicationId));
    const { applicationFormBuffer } = await import('./forms/application-form.js');
    const buf = await applicationFormBuffer(getDb(), Number(req.params.applicationId));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="application-form-${req.params.applicationId}.pdf"`);
    res.end(buf);
  }));

// Customer-wise report — ported from wealth's report of the same name. One
// row per customer (DOB/PAN/address/TDS + a 3-way money split), each
// customer's individual NCDs nested for the expandable UI / detail sheet.
reportsRouter.get('/customer-wise', requirePermission('reports:download'),
  asyncHandler(async (req, res) => {
    const rows = await book.customerWiseReport(getDb(), req.user!);
    res.json({
      customers: rows,
      count: rows.length,
      grand_total: rows.reduce((s, r) => s + r.total_invested, 0),
      investments: rows.reduce((s, r) => s + r.applications.length, 0),
    });
  }));

reportsRouter.get('/customer-wise.xlsx', requirePermission('reports:download'),
  asyncHandler(async (req, res) => {
    const rows = await book.customerWiseReport(getDb(), req.user!);
    const { customerWiseXlsx } = await import('./documents.js');
    const buf = await customerWiseXlsx(rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="customer-wise-report.xlsx"');
    res.end(buf);
  }));

// Series-wise holder list with demat details — one row per unique holder in the
// chosen series (name, PAN, total invested, depository / DP ID / Client ID).
reportsRouter.get('/series-holders', requirePermission('reports:download'),
  asyncHandler(async (req, res) => {
    const seriesId = Number(req.query.series_id);
    if (!seriesId) { res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'series_id is required' } }); return; }
    const meta = (await getDb().query<{ code: string; name: string }>('SELECT code, name FROM series WHERE id = $1', [seriesId])).rows[0];
    if (!meta) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Series not found' } }); return; }
    const rows = await book.seriesHoldersReport(getDb(), req.user!, seriesId);
    res.json({
      series_code: meta.code, series_name: meta.name, rows, count: rows.length,
      grand_total: rows.reduce((s, r) => s + r.total_invested, 0),
      investments: rows.reduce((s, r) => s + r.investments, 0),
    });
  }));

reportsRouter.get('/series-holders.xlsx', requirePermission('reports:download'),
  asyncHandler(async (req, res) => {
    const seriesId = Number(req.query.series_id);
    if (!seriesId) { res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'series_id is required' } }); return; }
    const meta = (await getDb().query<{ code: string }>('SELECT code FROM series WHERE id = $1', [seriesId])).rows[0];
    if (!meta) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Series not found' } }); return; }
    const rows = await book.seriesHoldersReport(getDb(), req.user!, seriesId);
    const { seriesHoldersXlsx } = await import('./documents.js');
    const buf = await seriesHoldersXlsx(meta.code, rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="series-holders-${meta.code}.xlsx"`);
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
