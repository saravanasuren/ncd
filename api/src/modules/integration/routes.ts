/**
 * Integration façade (docs/08 §1) — LockerHub / DhanamFin-facing endpoints.
 * Own key auth, no cookie/CSRF. Response SHAPES are the external contract
 * (byte-compatible with the legacy wealth app); these are thin adapters over
 * the same services first-party routes use. Contract-tested.
 *
 * Split (mirrors the legacy routes/integration/* layout):
 *   auth.ts   — customer auth LA1–LA4 + select-account
 *   reads.ts  — customer reads L1–L10 + SOA/ledger + ncd/match + deposit status
 *   writes.ts — penny-drop, profile sync, leads, subscriptions, redemptions,
 *               funded payments, locker deposits
 *   agents.ts — agent mirror, email-check, authenticate, webview session
 *
 * This file keeps only the ncd-native additions (customers/by-phone summary,
 * KYC-doc mirror) and mounts the split routers.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireIntegrationKey } from '../../middleware/integrationAuth.js';
import { errors } from '../../lib/errors.js';
import { customerAuthRouter } from './auth.js';
import { customerReadsRouter } from './reads.js';
import { customerWritesRouter } from './writes.js';
import { agentsRouter } from './agents.js';

export const integrationRouter = Router();
integrationRouter.use(requireIntegrationKey);

/** ncd-native summary lookup (kept alongside the legacy /customer-by-phone). */
integrationRouter.get('/customers/by-phone/:phone', asyncHandler(async (req, res) => {
  const { rows } = await getDb().query<Record<string, unknown>>(
    `SELECT id, customer_code, full_name, phone, email, kyc_status FROM customers WHERE phone = $1 AND is_active = TRUE LIMIT 1`, [req.params.phone]);
  if (!rows[0]) throw errors.notFound('Customer not found');
  const c = rows[0];
  res.json({ id: Number(c.id), customer_code: c.customer_code, name: c.full_name, phone: c.phone, email: c.email, kyc_status: c.kyc_status });
}));

/** KYC-doc mirror — DhanamFin app pushes a captured KYC document into Wealth. */
integrationRouter.post('/customers/:id/kyc-docs', asyncHandler(async (req, res) => {
  const b = z.object({ doc_type: z.string(), filename: z.string(), mime: z.string(), data_base64: z.string().min(1) }).parse(req.body);
  const db = getDb();
  const cust = await db.query('SELECT 1 FROM customers WHERE id = $1', [Number(req.params.id)]);
  if (!cust.rowCount) throw errors.notFound('Customer not found');
  const { validateUpload } = await import('../../lib/uploads.js');
  const { buffer, mime } = validateUpload(b.data_base64); // sniffed mime — client's is ignored
  const { saveBuffer } = await import('../../lib/storage.js');
  const { path } = saveBuffer('kyc-docs', b.filename, buffer);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customer_documents (customer_id, doc_type, file_path, original_filename, mime, origin) VALUES ($1,$2,$3,$4,$5,'dhanamfin') RETURNING id`,
    [Number(req.params.id), b.doc_type, path, b.filename, mime]);
  res.status(201).json({ id: Number(rows[0]!.id), origin: 'dhanamfin' });
}));

// Legacy-contract routers (docs/08 §1 — byte-compatible shapes).
integrationRouter.use(customerAuthRouter);
integrationRouter.use(customerReadsRouter);
integrationRouter.use(customerWritesRouter);
integrationRouter.use(agentsRouter);
