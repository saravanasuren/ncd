/**
 * Bulk Redemption Letter routes.
 *
 * Every endpoint is a pure function of the uploaded file: nothing is stored
 * between calls, so the sheet is posted again to generate after previewing. The
 * files are a few tens of kilobytes, which is cheaper than holding server-side
 * state that could go stale behind the operator's back.
 *
 * Gated on `redemptions:initiate` — the permission behind the existing
 * Redemptions page, so whoever already handles redemptions can prepare these
 * letters and nobody else gains a new power.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const bulkLettersRouter = Router();
const perm = requirePermission('redemptions:initiate');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The blank sheet to fill in, with its notes tab. */
bulkLettersRouter.get('/template.xlsx', perm, asyncHandler(async (_req, res) => {
  const buf = await s.templateWorkbook();
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', 'attachment; filename="redemption-letters-template.xlsx"');
  res.send(buf);
}));

const upload = z.object({
  filename: z.string().min(1),
  data_base64: z.string().min(1),
});

/** Read and check the sheet. Produces nothing — this is the preview step. */
bulkLettersRouter.post('/preview', perm, asyncHandler(async (req, res) => {
  const b = upload.parse(req.body);
  const buf = Buffer.from(b.data_base64, 'base64');
  res.json(await s.previewUpload(getDb(), buf, b.filename));
}));

/** Render every valid row and return the bundle. */
bulkLettersRouter.post('/generate', perm, asyncHandler(async (req, res) => {
  const b = upload.parse(req.body);
  const buf = Buffer.from(b.data_base64, 'base64');
  const out = await s.generateLetters(getDb(), buf, b.filename);
  // The counts ride in headers so the page can report them beside the download
  // without parsing the archive it just received.
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="redemption-letters.zip"');
  res.setHeader('X-Letters-Generated', String(out.generated));
  res.setHeader('X-Letters-Failed', String(out.failed.length));
  res.setHeader('Access-Control-Expose-Headers', 'X-Letters-Generated, X-Letters-Failed');
  res.send(out.zip);
}));

/** One row's letter, for the per-row download. */
bulkLettersRouter.post('/letter', perm, asyncHandler(async (req, res) => {
  const b = upload.extend({ row_no: z.coerce.number().int().positive() }).parse(req.body);
  const buf = Buffer.from(b.data_base64, 'base64');
  const out = await s.generateOne(getDb(), buf, b.filename, b.row_no);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename.replace(/"/g, '')}"`);
  res.send(out.pdf);
}));
