/** Customers routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';
import { serveHeaders } from '../../lib/uploads.js';

export const customersRouter = Router();

customersRouter.get('/', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const filters = { status: req.query.status as string, district: req.query.district as string, q: req.query.q as string };
    res.json({ rows: await s.listCustomers(getDb(), req.user!, filters) });
  }));

const createSchema = z.object({
  full_name: z.string().min(1),
  pan: z.string().optional(),
  dob: z.string().optional(),
  gender: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  district: z.string().optional(),
  state: z.string().optional(),
  is_nri: z.boolean().optional(),
  referred_by_text: z.string().optional(),
  father_name: z.string().optional(),
  occupation: z.string().optional(),
  aadhaar_last4: z.string().optional(),
  phone_secondary: z.string().optional(),
  investor_category: z.string().optional(),
  ckyc_number: z.string().optional(),
  tds_applicable: z.boolean().optional(),
});

customersRouter.post('/', requirePermission('customers:create'),
  asyncHandler(async (req, res) => res.status(201).json(await s.createCustomer(getDb(), req.user!, createSchema.parse(req.body)))));

// Active staff a customer can be handed over to (picker for handover-request).
// Registered BEFORE '/:id' so the literal path isn't captured by the param route.
customersRouter.get('/assignable-staff', requirePermission('customers:handover-request'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.listAssignableStaff(getDb()) })));

customersRouter.get('/:id', requirePermission('customers:read'),
  asyncHandler(async (req, res) => res.json(await s.getCustomerDetail(getDb(), req.user!, Number(req.params.id)))));

customersRouter.post('/:id/bank-accounts', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    const b = z.object({
      account_number: z.string().min(4), ifsc: z.string().min(4),
      bank_name: z.string().optional(), branch_name: z.string().optional(), branch_city: z.string().optional(),
      account_type: z.string().optional(), holder_name: z.string().optional(), tds_applicable: z.boolean().optional(),
    }).parse(req.body);
    res.status(201).json(await s.addBankAccount(getDb(), req.user!, Number(req.params.id), b));
  }));

customersRouter.post('/:id/bank-accounts/:bankId/set-active', requirePermission('customers:update'),
  asyncHandler(async (req, res) => { await s.setActiveBank(getDb(), req.user!, Number(req.params.id), Number(req.params.bankId)); res.json({ ok: true }); }));

customersRouter.post('/:id/kyc/verify', requirePermission('kyc:verify'),
  asyncHandler(async (req, res) => { await s.setKyc(getDb(), req.user!, Number(req.params.id), 'Verified'); res.json({ ok: true }); }));

customersRouter.post('/:id/kyc/reject', requirePermission('kyc:reject'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(2) }).parse(req.body);
    await s.setKyc(getDb(), req.user!, Number(req.params.id), 'Rejected', reason);
    res.json({ ok: true });
  }));

customersRouter.post('/:id/submit-for-approval', requirePermission('customers:create'),
  asyncHandler(async (req, res) => res.status(201).json({ request: await s.submitForApproval(getDb(), req.user!, Number(req.params.id)) })));

customersRouter.post('/:id/correction-request', requirePermission('customers:correction-request'),
  asyncHandler(async (req, res) => {
    const { changes, reason } = z.object({ changes: z.record(z.unknown()), reason: z.string().min(2) }).parse(req.body);
    res.status(201).json({ request: await s.requestCorrection(getDb(), req.user!, Number(req.params.id), changes, reason) });
  }));

customersRouter.post('/:id/handover-request', requirePermission('customers:handover-request'),
  asyncHandler(async (req, res) => {
    const { toUserId, reason } = z.object({ toUserId: z.number(), reason: z.string().min(2) }).parse(req.body);
    res.status(201).json({ request: await s.requestHandover(getDb(), req.user!, Number(req.params.id), toUserId, reason) });
  }));

// Relations
customersRouter.put('/:id/joint-holders', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    // nullish (not optional): the UI round-trips existing rows whose blank fields come back as NULL.
    const { holders } = z.object({ holders: z.array(z.object({ full_name: z.string().min(1), pan: z.string().nullish(), phone: z.string().nullish(), relationship: z.string().nullish() })) }).parse(req.body);
    res.json(await s.setJointHolders(getDb(), req.user!, Number(req.params.id), holders));
  }));
customersRouter.put('/:id/nominees', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    const { nominees } = z.object({ nominees: z.array(z.object({
      full_name: z.string().min(1), relationship: z.string().nullish(), share_pct: z.number().nullish(), dob: z.string().nullish(),
      pan: z.string().nullish(), phone: z.string().nullish(), address: z.string().nullish(), guardian_name: z.string().nullish(), guardian_pan: z.string().nullish(),
    })) }).parse(req.body);
    res.json(await s.setNominees(getDb(), req.user!, Number(req.params.id), nominees));
  }));
customersRouter.put('/:id/demat', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    const { dp_id, client_id, depository } = z.object({ dp_id: z.string(), client_id: z.string(), depository: z.string().nullish() }).parse(req.body);
    res.json(await s.setDemat(getDb(), req.user!, Number(req.params.id), dp_id, client_id, depository));
  }));

// Deceased flag (delete/destructive-ish → Super Admin/Admin via customers:deactivate)
customersRouter.post('/:id/deceased', requirePermission('customers:deactivate'),
  asyncHandler(async (req, res) => {
    const { deceased_date } = z.object({ deceased_date: z.string() }).parse(req.body);
    res.json(await s.markDeceased(getDb(), req.user!, Number(req.params.id), deceased_date));
  }));

// KYC documents
customersRouter.post('/:id/documents', requirePermission('customers:update', 'kyc:verify'),
  asyncHandler(async (req, res) => {
    const b = z.object({ doc_type: z.string(), filename: z.string(), mime: z.string(), data_base64: z.string().min(1) }).parse(req.body);
    res.status(201).json(await s.addDocument(getDb(), req.user!, Number(req.params.id), b.doc_type, b.filename, b.mime, b.data_base64));
  }));
customersRouter.get('/:id/documents/:docId', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const d = await s.getDocument(getDb(), req.user!, Number(req.params.id), Number(req.params.docId));
    if (!d) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No document' } }); return; }
    const h = serveHeaders(d.mime, d.filename, 'document');
    res.setHeader('Content-Type', h.type);
    res.setHeader('Content-Disposition', h.disposition);
    res.end(d.buffer);
  }));

// DigiLocker/Aadhaar KYC (stub)
customersRouter.post('/:id/kyc/digilocker/start', requirePermission('kyc:verify'),
  asyncHandler(async (req, res) => res.json(await s.startDigilocker(getDb(), req.user!, Number(req.params.id)))));
customersRouter.post('/:id/kyc/digilocker/complete', requirePermission('kyc:verify'),
  asyncHandler(async (req, res) => res.json(await s.completeDigilocker(getDb(), req.user!, Number(req.params.id)))));
