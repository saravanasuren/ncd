/** Directory lookups used during enrolment (IFSC → bank/branch). Read-only. */
import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import { lookupIfsc } from '../../integrations/ifsc.js';

export const lookupsRouter = Router();

// Any staff who can read customers can resolve an IFSC while adding a bank
// account. Returns { found:false } (not an error) for an unknown/invalid code
// so the form can fall back to manual entry.
lookupsRouter.get('/ifsc/:code', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const info = await lookupIfsc(req.params.code!);
    res.json(info ? { found: true, ...info } : { found: false });
  }));
