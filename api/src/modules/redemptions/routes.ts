/** Redemption routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const redemptionsRouter = Router();

redemptionsRouter.get('/', requirePermission('redemptions:initiate', 'dashboard:view'),
  asyncHandler(async (req, res) => res.json({ rows: await s.listRedemptions(getDb(), req.user!, req.query.filter === 'requests' ? 'requests' : 'all') })));

redemptionsRouter.post('/premature', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    // `amount` = partial withdrawal (capped at the unpledged portion). Omitted
    // → redeem everything that isn't pledged to a live locker deposit.
    const input = z.object({
      application_id: z.number(), redemption_date: z.string().optional(), reason: z.string().min(2),
      amount: z.number().positive().optional(),
      // REQUIRED (owner 2026-11-20). It prints on the consent letter the
      // holder signs, and it cannot be derived — demat details were only ever
      // synced for about a third of the book, so an empty record is not
      // evidence of a physical holding. A moment's thought at the desk beats
      // a guess on a signed document.
      holding_mode: z.enum(['Demat', 'Physical']),
    }).parse(req.body);
    res.status(201).json(await s.initiatePremature(getDb(), req.user!, input));
  }));

// CXO waives / discounts the premature penalty before approving.
redemptionsRouter.post('/:id/waive-penalty', requirePermission('approvals:check-premature'),
  asyncHandler(async (req, res) => {
    const input = z.object({ new_penalty: z.number().min(0), reason: z.string().min(3) }).parse(req.body);
    res.json(await s.adjustPrematurePenalty(getDb(), req.user!, Number(req.params.id), input));
  }));

// The approver corrects the redemption date before approving. PENDING ONLY
// (owner 2026-11-04: "once its approved means the money is gone out") — and the
// date drives the broken-period interest, which is recomputed with it.
redemptionsRouter.post('/:id/redemption-date', requirePermission('approvals:check-premature'),
  asyncHandler(async (req, res) => {
    const input = z.object({
      redemption_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
      reason: z.string().min(3),
    }).parse(req.body);
    res.json(await s.changePrematureRedemptionDate(getDb(), req.user!, Number(req.params.id), input));
  }));

// ── The customer's signed request letter (owner 2026-11-18) ────────────────
// Nothing here moves money. These routes prepare the letter, record how it was
// signed and serve the two documents an approver needs to look at. The gate
// itself lives in the service, on submit-for-approval and again on approval.

// What the investment screen asks on every render: is there a redemption in
// flight on this investment, and what is it waiting for? Three segments, so it
// cannot be swallowed by the two-segment '/:id/signing' below.
redemptionsRouter.get('/for-application/:applicationId/signing', requirePermission('redemptions:initiate', 'approvals:check-premature'),
  asyncHandler(async (req, res) => res.json(await s.liveRedemptionForApplication(getDb(), Number(req.params.applicationId)))));

// Where this redemption's letter stands, in the owner's own stage words.
redemptionsRouter.get('/:id/signing', requirePermission('redemptions:initiate', 'approvals:check-premature'),
  asyncHandler(async (req, res) => res.json(await s.signingView(getDb(), Number(req.params.id)))));

// Regenerate — staff fixed a bank account or a spelling. Refused once signed.
redemptionsRouter.post('/:id/letter', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => res.json(await s.generateLetter(getDb(), req.user!, Number(req.params.id)))));

// How it is going to be signed: on paper, or through Digio.
redemptionsRouter.post('/:id/letter/method', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    const { method } = z.object({ method: z.enum(['esign', 'physical']) }).parse(req.body);
    res.json(await s.setMethod(getDb(), req.user!, Number(req.params.id), method));
  }));

// Send the generated letter to Digio. The link goes to the customer by SMS.
redemptionsRouter.post('/:id/letter/esign', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    const { initiateRedemptionLetterSigning } = await import('../../integrations/digio/service.js');
    res.status(201).json(await initiateRedemptionLetterSigning(getDb(), req.user!, Number(req.params.id)));
  }));

// Ask Digio directly whether a stalled link was ever signed. Only earns its
// keep outside the poller's window — inside it the cron asked seconds ago.
redemptionsRouter.post('/:id/letter/esign/check', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    const { checkOneRedemptionLetter } = await import('../../integrations/digio/service.js');
    res.json(await checkOneRedemptionLetter(getDb(), Number(req.params.id)));
  }));

// The letter we generated, exactly as stored — not re-rendered. The customer
// signs THIS file, so serving a fresh render could hand back a different one.
redemptionsRouter.get('/:id/letter.pdf', requirePermission('redemptions:initiate', 'approvals:check-premature'),
  asyncHandler(async (req, res) => {
    const { buffer, mime, filename } = await s.redemptionLetterFile(getDb(), req.user!, Number(req.params.id), 'letter');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.end(buffer);
  }));

// The scan that came back, for the approver to check the signature on.
redemptionsRouter.get('/:id/signed-letter.pdf', requirePermission('redemptions:initiate', 'approvals:check-premature'),
  asyncHandler(async (req, res) => {
    const { buffer, mime, filename } = await s.redemptionLetterFile(getDb(), req.user!, Number(req.params.id), 'signed');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.end(buffer);
  }));

// The signed paper copy, scanned back in.
redemptionsRouter.post('/:id/signed-letter', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    const input = z.object({
      data_base64: z.string().min(1),
      filename: z.string().optional().nullable(),
      signed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
      note: z.string().optional().nullable(),
    }).parse(req.body);
    res.status(201).json(await s.uploadSignedLetter(getDb(), req.user!, Number(req.params.id), input));
  }));

// Staff picks up a customer/app request and starts the 2-level approval.
redemptionsRouter.post('/:id/submit-for-approval', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => res.status(201).json({ request: await s.submitForApproval(getDb(), req.user!, Number(req.params.id)) })));

redemptionsRouter.post('/maturity', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    const { application_id } = z.object({ application_id: z.number() }).parse(req.body);
    res.status(201).json(await s.initiateMaturity(getDb(), req.user!, application_id));
  }));

// The BULK sheet is gone (owner 2026-10-16: "remove that button"). It handed
// out every payable line at once, which is the opposite of releasing a payment
// instruction deliberately, one customer at a time. Removing the route as well
// as the button: a link that still answers is a link someone will still use.

redemptionsRouter.get('/:id/neft.xlsx', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const buf = await s.redemptionNeft(getDb(), req.user!, id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="redemption-neft-${id}.xlsx"`);
    res.end(buf);
  }));

// Record the bank reference once the money has gone. Anyone who handles
// redemptions may enter one; only a Super Admin may change one already there
// (enforced in the service, where the scope check also lives).
redemptionsRouter.post('/:id/utr', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    const { utr } = z.object({ utr: z.string().min(1) }).parse(req.body);
    res.json(await s.setRedemptionUtr(getDb(), req.user!, Number(req.params.id), utr));
  }));

redemptionsRouter.get('/report.xlsx', requirePermission('redemptions:initiate', 'reports:download'),
  asyncHandler(async (req, res) => {
    const buf = await s.redemptionReport(getDb(), req.user!);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="redemption-report.xlsx"');
    res.end(buf);
  }));
