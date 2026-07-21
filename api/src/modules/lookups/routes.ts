/** Directory lookups used during enrolment (IFSC → bank/branch, PIN → city/state,
 * penny-drop). Read-only; each returns { found:false } (not an error) on a
 * miss/failure so the form falls back to manual entry. */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import { lookupIfsc } from '../../integrations/ifsc.js';
import { lookupPincode } from '../../integrations/pincode.js';
import { kycProvider } from '../../integrations/kyc/index.js';

export const lookupsRouter = Router();

// Any staff who can read customers can resolve an IFSC while adding a bank
// account. Returns { found:false } (not an error) for an unknown/invalid code
// so the form can fall back to manual entry.
lookupsRouter.get('/ifsc/:code', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const info = await lookupIfsc(req.params.code!);
    res.json(info ? { found: true, ...info } : { found: false });
  }));

// PIN → state / city (District). Editable after autofill.
lookupsRouter.get('/pincode/:pin', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const info = await lookupPincode(req.params.pin!);
    res.json(info ? { found: true, ...info } : { found: false });
  }));

// Penny-drop a bank account during enrolment (verify + name-on-record) WITHOUT
// saving anything. The staff console reads the verdict before adding the account.
lookupsRouter.post('/penny-drop', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const b = z.object({ account_number: z.string().min(4), ifsc: z.string().min(11), name: z.string().optional() }).parse(req.body ?? {});
    const r = await kycProvider().pennyDrop(b.account_number.replace(/\s/g, ''), b.ifsc.toUpperCase().trim(), b.name);
    res.json({ status: r.status, name_on_record: r.holderName ?? null, detail: r.detail });
  }));
