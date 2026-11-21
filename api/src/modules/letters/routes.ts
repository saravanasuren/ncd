/**
 * Letter configuration routes.
 *
 * Gated on `settings:manage` — the same right that used to move
 * `redemption.letter_dhanam_from` and `redemption.consent_letter_from`, which
 * is what this screen replaces. Nobody gains a power they did not have; the
 * two settings simply became one screen with more of the letter on it.
 *
 * Nothing here moves money or touches a redemption. The worst a bad save can
 * do is print the wrong block on a letter — and because the table holds
 * overrides rather than the letters themselves, Reset puts it back.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const lettersRouter = Router();

const lineArray = z.array(z.string().max(200)).max(12);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const patchSchema = z.object({
  kind: z.enum(['request', 'consent']).optional(),
  label: z.string().min(2).max(120).optional(),
  // null is meaningful: "from the beginning" / "open-ended".
  valid_from: isoDate.nullable().optional(),
  valid_to: isoDate.nullable().optional(),
  legal_name: z.string().max(200).optional(),
  formerly: z.string().max(200).optional(),
  off_address: lineArray.optional(),
  corp_office: lineArray.optional(),
  body: z.record(z.string(), z.string().max(4000)).optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
  enabled: z.boolean().optional(),
});

lettersRouter.get('/', requirePermission('settings:manage'),
  asyncHandler(async (_req, res) => {
    const templates = await s.listTemplates(getDb());
    res.json({ templates, warnings: s.rangeWarnings(templates) });
  }));

lettersRouter.put('/:slug', requirePermission('settings:manage'),
  asyncHandler(async (req, res) => {
    const patch = patchSchema.parse(req.body);
    const template = await s.saveTemplate(getDb(), req.user!, String(req.params.slug), patch);
    const templates = await s.listTemplates(getDb());
    res.json({ template, warnings: s.rangeWarnings(templates) });
  }));

// Undo: drop the override and go back to the built-in letter.
lettersRouter.delete('/:slug', requirePermission('settings:manage'),
  asyncHandler(async (req, res) => {
    await s.resetTemplate(getDb(), req.user!, String(req.params.slug));
    const templates = await s.listTemplates(getDb());
    res.json({ templates, warnings: s.rangeWarnings(templates) });
  }));

/**
 * Which letter a given date produces — the question the screen exists to
 * answer, asked directly so the owner can check a date without uploading a
 * spreadsheet to find out.
 */
lettersRouter.get('/resolve/:date', requirePermission('settings:manage'),
  asyncHandler(async (req, res) => {
    const date = isoDate.parse(String(req.params.date));
    res.json({ date, template: await s.templateFor(getDb(), date) });
  }));
