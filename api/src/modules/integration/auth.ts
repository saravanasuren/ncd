/**
 * LockerHub façade — customer authentication LA1–LA4 + account selection
 * (docs/08 §1). Wire shapes byte-compatible with the legacy
 * routes/integration/customer-auth.js:
 *
 *   POST /auth/customer/lookup   { phone }                      → found + masked details (+ accounts[])
 *   POST /auth/otp/request       { phone }                      → always success (no enumeration)
 *   POST /auth/otp/verify        { phone, otp }                 → 24h HMAC-JWT token (or account picker)
 *   POST /auth/select-account    { selection_token, customer_id } → token scoped to one customer
 *   POST /auth/token/validate    { token }                      → stateless verification
 *
 * OTP storage reuses ncd's customer_otp_sessions (004_portal_integration):
 * bcrypt-hashed OTP, `attempts` / `used_at` columns. Same limits as legacy:
 * 6 digits, 10-min TTL, 5 verify attempts, 3 requests per 5 minutes.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { writeAudit } from '../../lib/audit.js';
import { enqueue, drainOnce } from '../notifications/service.js';
import {
  activeCustomersByPhone, genOtp, maskEmail, normalisePhone,
  signToken, verifyToken, TOKEN_TTL_SECONDS,
} from './shared.js';

const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_WINDOW_MIN = 5;
const OTP_RATE_MAX = 3;

export const customerAuthRouter = Router();

// ─── LA1 · Customer lookup (dedup check) ─────────────────────────────────
customerAuthRouter.post('/auth/customer/lookup', asyncHandler(async (req, res) => {
  const phone = normalisePhone((req.body ?? {}).phone ?? '');
  if (phone.length < 10) {
    return res.status(400).json({ error: 'phone required (10 digits minimum)', code: 'phone_required' });
  }
  const rows = await activeCustomersByPhone(getDb(), phone);
  if (rows.length === 0) return res.json({ found: false });

  const c = rows[0]!;
  const rawPhone = String(c.phone || phone).replace(/\D/g, '').slice(-10);
  const maskedPhone = rawPhone.length >= 4 ? '••••••' + rawPhone.slice(-4) : '•••';

  res.json({
    found: true,
    // Legacy single-customer fields (backward compat — first customer)
    customer_id: Number(c.id),
    customer_code: c.customer_code,
    name: c.full_name,
    kyc_status: c.kyc_status || 'Pending',
    masked_phone: maskedPhone,
    masked_email: maskEmail(c.email),
    // Multi-customer fields
    multiple_accounts: rows.length > 1,
    account_count: rows.length,
    accounts: rows.map((r) => ({
      customer_id: Number(r.id),
      customer_code: r.customer_code,
      name: r.full_name,
      kyc_status: r.kyc_status || 'Pending',
    })),
  });
}));

// ─── LA2 · Request OTP ───────────────────────────────────────────────────
customerAuthRouter.post('/auth/otp/request', asyncHandler(async (req, res) => {
  const phone = normalisePhone((req.body ?? {}).phone ?? '');
  if (phone.length < 10) {
    return res.status(400).json({ error: 'phone required (10 digits minimum)', code: 'phone_required' });
  }
  const db = getDb();
  const customers = await activeCustomersByPhone(db, phone);
  const customer = customers[0] ?? null;

  if (customer) {
    // Rate-limit against the primary customer for this phone.
    const recent = (await db.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM customer_otp_sessions
        WHERE customer_id = $1 AND created_at >= now() - interval '${OTP_RATE_WINDOW_MIN} minutes'`,
      [customer.id]
    )).rows[0]!;
    if (parseInt(recent.cnt, 10) >= OTP_RATE_MAX) {
      return res.status(429).json({ error: `Too many OTP requests. Try again in ${OTP_RATE_WINDOW_MIN} minutes.` });
    }

    const otp = genOtp();
    const otpHash = await bcrypt.hash(otp, 8);
    const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000).toISOString();
    await db.withTx(async (tx) => {
      await tx.query(
        `INSERT INTO customer_otp_sessions (customer_id, otp_hash, channel, destination, expires_at)
         VALUES ($1,$2,'sms',$3,$4)`,
        [customer.id, otpHash, phone, expiresAt]
      );
      // Same channel/template conventions as the customer portal OTP.
      await enqueue(tx, { channel: 'sms', template: 'portal_otp', to: phone, payload: { otp, ttlMinutes: OTP_TTL_MIN, name: customer.full_name } });
    });
    // Notification failure must not block the API — the OTP is in the DB.
    try { await drainOnce(db, 5); } catch { /* non-fatal */ }
  }

  // Always success — never reveal whether the phone exists.
  res.json({
    success: true,
    masked_destination: '••••••' + phone.slice(-4),
    expires_in_seconds: OTP_TTL_MIN * 60,
  });
}));

// ─── LA3 · Verify OTP → customer token (or account picker) ───────────────
customerAuthRouter.post('/auth/otp/verify', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const phone = normalisePhone(body.phone ?? '');
  const otp = String(body.otp ?? '').trim();

  if (phone.length < 10) return res.status(400).json({ error: 'phone required', code: 'phone_required' });
  if (!otp) return res.status(400).json({ error: 'otp required', code: 'otp_required' });

  const db = getDb();
  const customers = await activeCustomersByPhone(db, phone);
  if (customers.length === 0) {
    // Don't reveal non-existence — treat the same as a wrong OTP.
    return res.status(422).json({ success: false, error: 'Invalid or expired OTP.', code: 'otp_invalid', attempts_remaining: 0 });
  }
  // The OTP session is stored against the first (oldest) customer for this phone.
  const customer = customers[0]!;

  const session = (await db.query<{ id: string; otp_hash: string; attempts: number }>(
    `SELECT id, otp_hash, attempts FROM customer_otp_sessions
      WHERE customer_id = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2
      ORDER BY created_at DESC LIMIT 1`,
    [customer.id, OTP_MAX_ATTEMPTS]
  )).rows[0];

  if (!session) {
    return res.status(422).json({ success: false, error: 'OTP has expired or too many attempts. Please request a new OTP.', code: 'otp_expired' });
  }

  // Increment the attempt count first (prevents a retry race).
  await db.query('UPDATE customer_otp_sessions SET attempts = attempts + 1 WHERE id = $1', [session.id]);

  const match = await bcrypt.compare(String(otp).padStart(6, '0').slice(0, 6), session.otp_hash);
  if (!match) {
    const remaining = OTP_MAX_ATTEMPTS - (Number(session.attempts) + 1);
    return res.status(422).json({
      success: false,
      error: 'Invalid or expired OTP.',
      code: remaining > 0 ? 'otp_invalid' : 'otp_locked',
      attempts_remaining: Math.max(0, remaining),
    });
  }

  await db.query('UPDATE customer_otp_sessions SET used_at = now() WHERE id = $1', [session.id]);
  await writeAudit(db, {
    actorId: null,
    action: 'LOCKERHUB_OTP_VERIFY_SUCCESS',
    entityType: 'customers',
    entityId: Number(customer.id),
    after: { customer_code: customer.customer_code, source: 'lockerhub_ncd_auth', account_count: customers.length },
    ip: req.ip,
  });

  // Multiple accounts — return the picker list; the token comes from LA3.B.
  if (customers.length > 1) {
    const selectionToken = signToken({ id: 0, customer_code: 'SELECTION', full_name: phone + ':selection' });
    return res.json({
      success: true,
      needs_account_selection: true,
      verified_phone: phone,
      account_count: customers.length,
      accounts: customers.map((c) => ({
        customer_id: Number(c.id),
        customer_code: c.customer_code,
        name: c.full_name,
        kyc_status: c.kyc_status || 'Pending',
      })),
      selection_token: selectionToken,
      selection_token_expires_in_seconds: TOKEN_TTL_SECONDS,
    });
  }

  const token = signToken({ id: Number(customer.id), customer_code: customer.customer_code, full_name: customer.full_name });
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();
  res.json({
    success: true,
    needs_account_selection: false,
    customer_id: Number(customer.id),
    customer_code: customer.customer_code,
    name: customer.full_name,
    kyc_status: customer.kyc_status || 'Pending',
    token,
    expires_at: expiresAt,
    expires_in_seconds: TOKEN_TTL_SECONDS,
  });
}));

// ─── LA3.B · Select account after multi-account OTP verify ───────────────
customerAuthRouter.post('/auth/select-account', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const selectionToken = String(body.selection_token ?? '').trim();
  const customerId = parseInt(String(body.customer_id), 10);

  if (!selectionToken) return res.status(400).json({ error: 'selection_token required', code: 'selection_token_required' });
  if (!customerId || Number.isNaN(customerId)) return res.status(400).json({ error: 'customer_id required', code: 'customer_id_required' });

  const result = verifyToken(selectionToken);
  if (!result.valid) {
    return res.status(401).json({ error: 'Selection token invalid or expired. Please verify OTP again.', code: 'selection_token_invalid' });
  }
  if (result.claims.cid !== 0) {
    return res.status(401).json({ error: 'Token is not a selection token.', code: 'selection_token_invalid' });
  }

  const verifiedPhone = String(result.claims.name || '').replace(':selection', '');
  const db = getDb();
  const rows = await activeCustomersByPhone(db, verifiedPhone);
  const customer = rows.find((r) => Number(r.id) === customerId);
  if (!customer) {
    return res.status(403).json({ error: 'This account does not belong to the verified phone number.', code: 'account_not_found' });
  }

  const token = signToken({ id: Number(customer.id), customer_code: customer.customer_code, full_name: customer.full_name });
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();

  await writeAudit(db, {
    actorId: null,
    action: 'LOCKERHUB_ACCOUNT_SELECTED',
    entityType: 'customers',
    entityId: Number(customer.id),
    after: { customer_code: customer.customer_code, source: 'lockerhub_ncd_auth' },
    ip: req.ip,
  });

  res.json({
    success: true,
    customer_id: Number(customer.id),
    customer_code: customer.customer_code,
    name: customer.full_name,
    kyc_status: customer.kyc_status || 'Pending',
    token,
    expires_at: expiresAt,
    expires_in_seconds: TOKEN_TTL_SECONDS,
  });
}));

// ─── LA4 · Validate customer token (stateless) ───────────────────────────
customerAuthRouter.post('/auth/token/validate', asyncHandler(async (req, res) => {
  const token = String((req.body ?? {}).token ?? '').trim();
  if (!token) return res.status(400).json({ error: 'token required', code: 'token_required' });

  const result = verifyToken(token);
  if (!result.valid) return res.json({ valid: false, reason: result.reason });

  const { claims } = result;
  res.json({
    valid: true,
    customer_id: claims.cid,
    customer_code: claims.ccode,
    name: claims.name,
    expires_at: new Date(claims.exp * 1000).toISOString(),
  });
}));
