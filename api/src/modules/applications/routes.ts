/** Applications routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';
import * as purge from '../admin/purge.js';
import { serveHeaders } from '../../lib/uploads.js';

export const applicationsRouter = Router();

applicationsRouter.get('/', requirePermission('customers:read'),
  asyncHandler(async (req, res) => res.json(await s.listApplications(getDb(), req.user!, { status: req.query.status as string, series_id: req.query.series_id ? Number(req.query.series_id) : undefined, showArchived: req.query.showArchived === 'true' }))));

// Specific paths BEFORE '/:id' so they aren't captured by the param route.
applicationsRouter.get('/clubbing-candidates', requirePermission('applications:create'),
  asyncHandler(async (req, res) => res.json({ rows: await s.clubbingCandidates(getDb(), Number(req.query.customer_id), Number(req.query.series_id)) })));

applicationsRouter.get('/:id', requirePermission('customers:read'),
  asyncHandler(async (req, res) => res.json(await s.getApplicationDetail(getDb(), req.user!, Number(req.params.id)))));

applicationsRouter.post('/', requirePermission('applications:create'),
  asyncHandler(async (req, res) => {
    const input = z.object({ customer_id: z.number(), series_id: z.number(), scheme_id: z.number(), amount: z.number().positive(), date_money_received: z.string().optional(), collection_method: z.string().optional(), collection_reference: z.string().optional(), club_with_application_id: z.number().optional(), is_locker_deposit: z.boolean().optional() }).parse(req.body);
    res.status(201).json(await s.createApplication(getDb(), req.user!, input));
  }));

applicationsRouter.post('/:id/payout-account', requirePermission('applications:update'),
  asyncHandler(async (req, res) => {
    // null clears the pin, putting the NCD back on the customer's default.
    const { bank_account_id } = z.object({ bank_account_id: z.number().nullable() }).parse(req.body);
    res.json(await s.setPayoutAccount(getDb(), req.user!, Number(req.params.id), bank_account_id));
  }));

// Assign the referrer staff/agent on an app-channel investment (no referral
// code was given) and re-accrue the referrer incentive.
applicationsRouter.post('/:id/attribute-referrer', requirePermission('incentives:manage-eligibility'),
  asyncHandler(async (req, res) => {
    const { payee } = z.object({ payee: z.string().min(1) }).parse(req.body);
    res.json(await s.attributeReferrer(getDb(), req.user!, Number(req.params.id), payee));
  }));

// Start a Digio eSign session for this application (returns the sign URL).
// Stub/sandbox until DIGIO_* creds are in SSM; eSign is off the critical path.
applicationsRouter.post('/:id/esign/initiate', requirePermission('applications:mark-esigned'),
  asyncHandler(async (req, res) => {
    const { initiateSigning } = await import('../../integrations/digio/service.js');
    res.status(201).json(await initiateSigning(getDb(), req.user!, Number(req.params.id)));
  }));

applicationsRouter.post('/:id/receipt', requirePermission('applications:create', 'applications:update'),
  asyncHandler(async (req, res) => {
    const b = z.object({ filename: z.string(), mime: z.string(), data_base64: z.string().min(1) }).parse(req.body);
    res.status(201).json(await s.uploadReceipt(getDb(), req.user!, Number(req.params.id), b.filename, b.mime, b.data_base64));
  }));

applicationsRouter.get('/:id/receipt', requirePermission('customers:read', 'approvals:check'),
  asyncHandler(async (req, res) => {
    const { assertApplicationVisible } = await import('../../lib/visibility.js');
    await assertApplicationVisible(getDb(), req.user!, Number(req.params.id));
    const r = await s.getReceipt(getDb(), Number(req.params.id));
    if (!r) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No receipt' } }); return; }
    const h = serveHeaders(r.mime, r.filename, 'receipt');
    res.setHeader('Content-Type', h.type);
    res.setHeader('Content-Disposition', h.disposition);
    res.end(r.buffer);
  }));

applicationsRouter.post('/:id/locker-deposit', requirePermission('applications:update'),
  asyncHandler(async (req, res) => {
    const { is_locker_deposit } = z.object({ is_locker_deposit: z.boolean() }).parse(req.body);
    res.json(await s.setLockerDeposit(getDb(), req.user!, Number(req.params.id), is_locker_deposit));
  }));

applicationsRouter.post('/:id/mark-esigned', requirePermission('applications:mark-esigned'),
  asyncHandler(async (req, res) => { await s.markESigned(getDb(), req.user!, Number(req.params.id)); res.json({ ok: true }); }));

// Send the acknowledgement PDF to the customer over WhatsApp (approved ncd_akn
// template). Management-tier — same actors who confirm funds / update the app.
applicationsRouter.post('/:id/whatsapp-ack', requirePermission('notifications:admin', 'applications:update'),
  asyncHandler(async (req, res) => { res.json(await s.sendWhatsappAck(getDb(), Number(req.params.id))); }));

// ── Super-admin delete / archive (applications:delete → super_admin only) ──
applicationsRouter.post('/:id/archive', requirePermission('applications:delete'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().nullish() }).parse(req.body ?? {});
    res.json(await purge.setApplicationArchived(getDb(), req.user!, Number(req.params.id), true, reason ?? undefined));
  }));

applicationsRouter.post('/:id/unarchive', requirePermission('applications:delete'),
  asyncHandler(async (req, res) => {
    res.json(await purge.setApplicationArchived(getDb(), req.user!, Number(req.params.id), false));
  }));

// Permanent purge — irreversible. Requires an explicit confirm flag + a reason.
applicationsRouter.delete('/:id', requirePermission('applications:delete'),
  asyncHandler(async (req, res) => {
    const { confirm, reason } = z.object({ confirm: z.literal(true), reason: z.string().min(2) }).parse(req.body ?? {});
    void confirm;
    res.json(await purge.hardDeleteApplication(getDb(), req.user!, Number(req.params.id), reason));
  }));
