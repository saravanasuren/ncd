/**
 * Customer portal (docs/04 §2, docs/06 §5). OTP login (via the notification
 * queue), holdings, payouts (statement-cutoff filtered for display, full
 * aggregates), documents, service requests.
 */
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { round2 } from '../../lib/dates.js';
import { getSettingsMap } from '../settings/service.js';
import { enqueue, drainOnce } from '../notifications/service.js';
import { issueSession, type Tokens } from '../auth/service.js';
import { findAuthUserById } from '../users/repo.js';

function maskDest(dest: string): string {
  if (dest.includes('@')) { const [u, d] = dest.split('@'); return `${u!.slice(0, 2)}•••@${d}`; }
  return dest.length >= 4 ? `••••••${dest.slice(-4)}` : '••••';
}

async function findCustomerByIdentifier(db: Db, identifier: string) {
  const { rows } = await db.query<{ id: string; email: string | null; phone: string | null; full_name: string }>(
    `SELECT id, email, phone, full_name FROM customers
     WHERE (phone = $1 OR lower(email) = lower($1) OR customer_code = $1) AND is_active = TRUE LIMIT 1`,
    [identifier]
  );
  return rows[0] ?? null;
}

export async function requestOtp(db: Db, identifier: string): Promise<{ sent: boolean; destination: string }> {
  const settings = await getSettingsMap(db);
  const ttl = Number(settings['portal.otp_ttl_minutes'] ?? 10);
  const customer = await findCustomerByIdentifier(db, identifier);
  // Always return a masked destination shape (don't leak whether the id exists).
  if (!customer) return { sent: true, destination: maskDest(identifier) };

  const channel = customer.email ? 'email' : 'sms';
  const destination = customer.email ?? customer.phone ?? identifier;
  const otp = String(randomInt(100000, 1000000));
  const otpHash = await bcrypt.hash(otp, 8);
  const expires = new Date(Date.now() + ttl * 60000).toISOString();

  await db.withTx(async (tx) => {
    await tx.query('INSERT INTO customer_otp_sessions (customer_id, otp_hash, channel, destination, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [customer.id, otpHash, channel, destination, expires]);
    await enqueue(tx, { channel, template: 'portal_otp', to: destination, payload: { otp, ttlMinutes: ttl } });
  });
  await drainOnce(db, 5); // stub "sends" immediately
  return { sent: true, destination: maskDest(destination) };
}

export async function verifyOtp(db: Db, identifier: string, otp: string, meta: { ua?: string; ip?: string }): Promise<{ user: AuthUser; tokens: Tokens }> {
  const customer = await findCustomerByIdentifier(db, identifier);
  if (!customer) throw errors.unauthorized('Invalid code');
  const session = (await db.query<{ id: string; otp_hash: string; attempts: number }>(
    `SELECT id, otp_hash, attempts FROM customer_otp_sessions
     WHERE customer_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1`, [customer.id]
  )).rows[0];
  if (!session) throw errors.unauthorized('Code expired — request a new one');
  if (session.attempts >= 5) throw errors.unauthorized('Too many attempts');
  const ok = await bcrypt.compare(otp, session.otp_hash);
  if (!ok) {
    await db.query('UPDATE customer_otp_sessions SET attempts = attempts + 1 WHERE id = $1', [session.id]);
    throw errors.unauthorized('Invalid code');
  }
  await db.query('UPDATE customer_otp_sessions SET used_at = now() WHERE id = $1', [session.id]);

  // Ensure a portal user exists for this customer.
  const userId = await db.withTx(async (tx) => {
    const existing = (await tx.query<{ portal_user_id: string | null }>('SELECT portal_user_id FROM customers WHERE id = $1', [customer.id])).rows[0];
    if (existing?.portal_user_id) return Number(existing.portal_user_id);
    const roleId = (await tx.query<{ id: string }>("SELECT id FROM roles WHERE name = 'customer'")).rows[0]!.id;
    const email = customer.email ?? `customer-${customer.id}@portal.local`;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (email, full_name, role_id, is_active) VALUES ($1,$2,$3,TRUE) RETURNING id`,
      [email, customer.full_name, roleId]
    );
    const uid = Number(rows[0]!.id);
    await tx.query('UPDATE customers SET portal_user_id = $1 WHERE id = $2', [uid, customer.id]);
    return uid;
  });

  const user = await findAuthUserById(db, userId);
  if (!user) throw errors.unauthorized('Portal account error');
  const tokens = await issueSession(db, user, meta);
  return { user, tokens };
}

function requireCustomer(actor: AuthUser): number {
  if (actor.role !== 'customer' || !actor.customerId) throw errors.forbidden('Portal access only');
  return actor.customerId;
}

export async function holdings(db: Db, actor: AuthUser) {
  const cid = requireCustomer(actor);
  const { rows } = await db.query(
    `SELECT a.application_no, s.code AS series_code, a.total_amount, a.status, a.allotment_date, a.maturity_date
     FROM applications a JOIN series s ON s.id = a.series_id
     WHERE a.customer_id = $1 AND a.status IN ('Active','Matured') ORDER BY a.allotment_date DESC NULLS LAST, a.application_no DESC`, [cid]);
  const total = round2(rows.reduce((s, r) => s + Number((r as { total_amount: string }).total_amount), 0));
  return { holdings: rows, total_invested: total };
}

export async function payouts(db: Db, actor: AuthUser) {
  const cid = requireCustomer(actor);
  const settings = await getSettingsMap(db);
  const cutoff = String(settings['portal.statement_display_cutoff'] ?? '2026-06-19');
  // Aggregates from the FULL history; the list is cutoff-filtered for display.
  const agg = (await db.query<{ paid: string }>(
    `SELECT COALESCE(sum(ds.net_amount),0) AS paid FROM disbursement_schedule ds
     JOIN applications a ON a.id = ds.application_id
     WHERE a.customer_id = $1 AND ds.status = 'Paid' AND ds.due_type IN ('Interest','BrokenInterest')`, [cid])).rows[0]!;
  const list = (await db.query(
    `SELECT ds.due_date, ds.due_type, ds.net_amount, ds.status FROM disbursement_schedule ds
     JOIN applications a ON a.id = ds.application_id
     WHERE a.customer_id = $1 AND ds.due_date >= $2 ORDER BY ds.due_date DESC LIMIT 200`, [cid, cutoff])).rows;
  return { collected_to_date: round2(Number(agg.paid)), rows: list, display_cutoff: cutoff };
}

/** Customer requests early redemption of one of their own holdings. */
export async function requestRedemptionForCustomer(db: Db, actor: AuthUser, applicationNo: string, reason: string) {
  const cid = requireCustomer(actor);
  const app = (await db.query<{ id: string }>(
    "SELECT id FROM applications WHERE application_no = $1 AND customer_id = $2 AND status = 'Active'", [applicationNo, cid])).rows[0];
  if (!app) throw errors.notFound('Investment not found or not redeemable');
  const { requestRedemption } = await import('../redemptions/service.js');
  const r = await requestRedemption(db, { applicationId: Number(app.id), reason, source: 'portal', createdBy: actor.id });
  return { redemption_no: r.redemption_no, net_payment: r.netPayment, status: 'Requested' };
}

export async function documents(db: Db, actor: AuthUser) {
  const cid = requireCustomer(actor);
  const apps = (await db.query<{ id: string; application_no: string; allotment_date: string | null }>("SELECT id, application_no, allotment_date FROM applications WHERE customer_id = $1 AND status IN ('Active','Matured','Redeemed')", [cid])).rows;
  const docs: Array<{ id: string; label: string }> = [];
  for (const a of apps) {
    // Bond certificate / allotment letter only exist once the series is allotted.
    if (!a.allotment_date) continue;
    docs.push({ id: `BOND-${a.id}`, label: `Bond certificate — ${a.application_no}` });
    docs.push({ id: `ALLOT-${a.id}`, label: `Allotment letter — ${a.application_no}` });
  }
  docs.push({ id: `SOA-${cid}`, label: 'Statement of account' });
  return { documents: docs };
}

export async function createServiceRequest(db: Db, actor: AuthUser, kind: string, details: string) {
  const cid = requireCustomer(actor);
  const { rows } = await db.query<{ id: string }>('INSERT INTO portal_service_requests (customer_id, kind, details) VALUES ($1,$2,$3) RETURNING id', [cid, kind, details]);
  return { id: Number(rows[0]!.id) };
}

export async function listServiceRequests(db: Db, actor: AuthUser) {
  const cid = requireCustomer(actor);
  return (await db.query('SELECT id, kind, details, status, created_at FROM portal_service_requests WHERE customer_id = $1 ORDER BY id DESC', [cid])).rows;
}
