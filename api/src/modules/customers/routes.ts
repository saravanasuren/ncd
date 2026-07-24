/** Customers routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { ACCOUNT_NUMBER_RE, ALPHA_SPACE_RE, DP_ID_RE, IFSC_RE, NAME_RE, PAN_RE, ddmmyyyyToISO, isoToDDMMYYYY } from '@new-wealth/shared';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';
import * as purge from '../admin/purge.js';
import { serveHeaders } from '../../lib/uploads.js';

export const customersRouter = Router();

customersRouter.get('/', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const filters = { status: req.query.status as string, district: req.query.district as string, q: req.query.q as string, showArchived: req.query.showArchived === 'true' };
    res.json(await s.listCustomers(getDb(), req.user!, filters));
  }));

// Identity fields share the client's rules (shared/validation) so the wizard's
// checks can't be bypassed: person names take letters, spaces and the
// punctuation real names carry (. ' -) but never digits; occupation and
// city/district/state are letters and spaces only (all trimmed); PAN is
// ABCDE1234F (uppercased server-side too); dob arrives as ISO — the
// DD/MM/YYYY rule is the FORM's input format; the wizard converts before
// sending — and must be a real calendar date.
const personName = (label: string) => z.string().trim().min(1).regex(NAME_RE, `${label} may contain letters, spaces, dots, apostrophes and hyphens only`);
const alphaSpace = (label: string) => z.string().trim().min(1).regex(ALPHA_SPACE_RE, `${label} may contain letters and spaces only`);
const upper = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), schema);
const isoDate = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((v) => ddmmyyyyToISO(isoToDDMMYYYY(v)) !== null, 'Date must be a real calendar date');

const createSchema = z.object({
  full_name: personName('Full name'),
  pan: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
    z.string().regex(PAN_RE, 'PAN must be in the format ABCDE1234F').optional()),
  dob: isoDate.optional(),
  gender: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  city: alphaSpace('City').optional(),
  district: alphaSpace('District').optional(),
  state: alphaSpace('State').optional(),
  is_nri: z.boolean().optional(),
  referred_by_text: z.string().optional(),
  father_name: personName("Father's name").optional(),
  occupation: alphaSpace('Occupation').optional(),
  aadhaar_last4: z.string().optional(),
  aadhaar: z.string().optional(), // full 12-digit; last4 is derived from it
  phone_secondary: z.string().optional(),
  investor_category: z.string().optional(),
  ckyc_number: z.string().optional(),
  tds_applicable: z.boolean().optional(),
  pincode: z.string().optional(),
});

customersRouter.post('/', requirePermission('customers:create'),
  asyncHandler(async (req, res) => res.status(201).json(await s.createCustomer(getDb(), req.user!, createSchema.parse(req.body)))));

// Active staff a customer can be handed over to (picker for handover-request).
// Registered BEFORE '/:id' so the literal path isn't captured by the param route.
customersRouter.get('/assignable-staff', requirePermission('customers:handover-request'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.listAssignableStaff(getDb()) })));

customersRouter.get('/:id', requirePermission('customers:read'),
  asyncHandler(async (req, res) => res.json(await s.getCustomerDetail(getDb(), req.user!, Number(req.params.id)))));

// Tax position — drives TDS on every payout, so it is audited. Not in the
// correction whitelist because it is not a typo fix: it changes what the
// customer is paid.
customersRouter.patch('/:id/tax', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    const b = z.object({
      tds_applicable: z.boolean().optional(),
      tax_form: z.string().nullish(),
      tax_form_expires_on: z.string().nullish(),
    }).parse(req.body ?? {});
    res.json(await s.updateTaxStatus(getDb(), req.user!, Number(req.params.id), b));
  }));

customersRouter.post('/:id/bank-accounts', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    // Account number is digits-only (leading zeros are meaningful — it stays a
    // string); IFSC is the standard SBIN0001234 shape, uppercased server-side;
    // the name fields take the shared person-name rule (no digits).
    const b = z.object({
      account_number: z.string().trim().regex(ACCOUNT_NUMBER_RE, 'Account number must be digits only (at least 4)'),
      ifsc: upper(z.string().regex(IFSC_RE, 'IFSC must be 11 characters like SBIN0001234')),
      bank_name: personName('Bank name').optional(), branch_name: personName('Branch name').optional(), branch_city: personName('Branch city').optional(),
      account_type: z.string().optional(), holder_name: personName('Beneficiary name').optional(), tds_applicable: z.boolean().optional(),
    }).parse(req.body);
    res.status(201).json(await s.addBankAccount(getDb(), req.user!, Number(req.params.id), b));
  }));

// Correct a misspelt beneficiary name in place. customers:update (not the
// super-admin delete gate) — fixing a typo must not need a destructive right.
customersRouter.patch('/:id/bank-accounts/:bankId', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    const { holder_name } = z.object({
      holder_name: z.string().trim().min(2, 'Beneficiary name is required')
        .regex(NAME_RE, 'Beneficiary name may contain letters, spaces, dots, apostrophes and hyphens only'),
    }).parse(req.body ?? {});
    res.json(await s.updateBankAccountName(getDb(), req.user!, Number(req.params.id), Number(req.params.bankId), holder_name));
  }));

// Re-run the penny drop on an account already on file (a Failed status can be
// transient, or stale after the name was corrected).
customersRouter.post('/:id/bank-accounts/:bankId/reverify', requirePermission('customers:update'),
  asyncHandler(async (req, res) =>
    res.json(await s.reverifyBankAccount(getDb(), req.user!, Number(req.params.id), Number(req.params.bankId)))));

customersRouter.post('/:id/bank-accounts/:bankId/set-active', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    const b = z.object({ force: z.boolean().optional(), reason: z.string().optional() }).parse(req.body ?? {});
    await s.setActiveBank(getDb(), req.user!, Number(req.params.id), Number(req.params.bankId), b);
    res.json({ ok: true });
  }));

// Super-admin only — customers:delete is the same gate as customer delete.
customersRouter.delete('/:id/bank-accounts/:bankId', requirePermission('customers:delete'),
  asyncHandler(async (req, res) =>
    res.json(await s.deleteBankAccount(getDb(), req.user!, Number(req.params.id), Number(req.params.bankId)))));

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
      full_name: personName('Nominee name'), relationship: z.string().nullish(), share_pct: z.number().nullish(), dob: z.string().nullish(),
      pan: z.string().nullish(), phone: z.string().nullish(), address: z.string().nullish(), guardian_name: z.string().nullish(), guardian_pan: z.string().nullish(),
      kyc_id_type: z.string().nullish(), kyc_id_number: z.string().nullish(),
    })) }).parse(req.body);
    res.json(await s.setNominees(getDb(), req.user!, Number(req.params.id), nominees));
  }));
customersRouter.put('/:id/demat', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    // Blank clears the demat fields, so '' passes; anything else must be a full
    // 8-char DP ID — IN300456-style NSDL or 8-digit CDSL (shared DP_ID_RE).
    const { dp_id, client_id, depository } = z.object({
      dp_id: upper(z.string().refine((v) => v === '' || DP_ID_RE.test(v), 'DP ID must be 8 characters — two letters + six digits (e.g. IN300456) or eight digits (CDSL)')),
      client_id: z.string(),
      depository: z.string().nullish(),
    }).parse(req.body);
    res.json(await s.setDemat(getDb(), req.user!, Number(req.params.id), dp_id, client_id, depository));
  }));

// Deceased flag (delete/destructive-ish → Super Admin/Admin via customers:deactivate)
customersRouter.post('/:id/deceased', requirePermission('customers:deactivate'),
  asyncHandler(async (req, res) => {
    const { deceased_date } = z.object({ deceased_date: z.string() }).parse(req.body);
    res.json(await s.markDeceased(getDb(), req.user!, Number(req.params.id), deceased_date));
  }));

// ── Super-admin delete / archive (customers:delete → super_admin only) ─────
customersRouter.post('/:id/archive', requirePermission('customers:delete'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().nullish() }).parse(req.body ?? {});
    res.json(await purge.setCustomerArchived(getDb(), req.user!, Number(req.params.id), true, reason ?? undefined));
  }));

customersRouter.post('/:id/unarchive', requirePermission('customers:delete'),
  asyncHandler(async (req, res) => {
    res.json(await purge.setCustomerArchived(getDb(), req.user!, Number(req.params.id), false));
  }));

// Permanent purge — irreversible, cascades the customer's investments too.
customersRouter.delete('/:id', requirePermission('customers:delete'),
  asyncHandler(async (req, res) => {
    const { confirm, reason } = z.object({ confirm: z.literal(true), reason: z.string().min(2) }).parse(req.body ?? {});
    void confirm;
    res.json(await purge.hardDeleteCustomer(getDb(), req.user!, Number(req.params.id), reason));
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
