/** Portal routes (docs/04 §2). OTP is public; the rest need a customer session. */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import { setAuthCookies } from '../auth/cookies.js';
import * as s from './service.js';

export const portalRouter = Router();

portalRouter.post('/otp/request', asyncHandler(async (req, res) => {
  const { identifier } = z.object({ identifier: z.string().min(3) }).parse(req.body);
  res.json(await s.requestOtp(getDb(), identifier));
}));

portalRouter.post('/otp/verify', asyncHandler(async (req, res) => {
  const { identifier, otp } = z.object({ identifier: z.string().min(3), otp: z.string().min(4) }).parse(req.body);
  const { user, tokens } = await s.verifyOtp(getDb(), identifier, otp, { ua: req.get('user-agent') ?? undefined, ip: req.ip });
  setAuthCookies(res, tokens);
  res.json({ user });
}));

const self = requirePermission('portal:self-service');
portalRouter.get('/holdings', self, asyncHandler(async (req, res) => res.json(await s.holdings(getDb(), req.user!))));
portalRouter.get('/payouts', self, asyncHandler(async (req, res) => res.json(await s.payouts(getDb(), req.user!))));
portalRouter.get('/documents', self, asyncHandler(async (req, res) => res.json(await s.documents(getDb(), req.user!))));
portalRouter.get('/documents/:docId', self, asyncHandler(async (req, res) => {
  const { buffer, filename } = await s.documentPdf(getDb(), req.user!, String(req.params.docId));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.end(buffer);
}));
portalRouter.post('/redemption-request', self, asyncHandler(async (req, res) => {
  const { application_no, reason } = z.object({ application_no: z.string().min(3), reason: z.string().default('Customer request') }).parse(req.body);
  res.status(201).json(await s.requestRedemptionForCustomer(getDb(), req.user!, application_no, reason));
}));
portalRouter.get('/service-requests', self, asyncHandler(async (req, res) => res.json({ rows: await s.listServiceRequests(getDb(), req.user!) })));
portalRouter.post('/service-requests', self, asyncHandler(async (req, res) => {
  const { kind, details } = z.object({ kind: z.string().min(1), details: z.string().default('') }).parse(req.body);
  res.status(201).json(await s.createServiceRequest(getDb(), req.user!, kind, details));
}));
