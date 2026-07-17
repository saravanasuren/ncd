/**
 * LockerHub façade — shared helpers (docs/08 §1).
 *
 * Ported from the legacy wealth app's routes/integration/shared.js. Everything
 * here backs two or more of the sibling route files; wire-visible behaviour
 * (phone normalisation, customer-facing status vocabulary, token format) is
 * byte-compatible with the legacy implementation.
 */
import { createHash, createHmac, randomInt } from 'node:crypto';
import { config } from '../../config.js';
import type { Db } from '../../db/types.js';
import { getSettingsMap } from '../settings/service.js';

/** Strip non-digits, keep the last 10 (handles +91, spaces, hyphens…). */
export function normalisePhone(s: unknown): string {
  if (s == null) return '';
  return String(s).replace(/\D+/g, '').slice(-10);
}

/** SQL fragment: normalise a phone column the same way normalisePhone does. */
export function phoneMatchSql(col: string): string {
  return `RIGHT(REGEXP_REPLACE(COALESCE(${col},''),'\\D','','g'),10)`;
}

/**
 * Customer-facing status (legacy 2026-06-15 rule, docs/08 §1): the investor
 * never sees internal gate states — a funded investment reads "Active" from
 * the moment it lands, wherever it sits in the approval/allotment pipeline.
 */
export function customerFacingStatus(internal: string | null | undefined, isMatured: boolean): string {
  if (isMatured) return 'Matured';
  switch (internal) {
    case 'PendingApproval':
    case 'PendingFundVerification':
    case 'PendingEsign':
    case 'PendingActivation':
    case 'PendingAllotment':
    case 'Active':
      return 'Active';
    case 'RolledOver': return 'Rolled Over';
    case 'PrematureWithdrawn': return 'Withdrawn';
    case 'Matured': return 'Matured';
    default: return internal || 'Active';
  }
}

/** yyyy-mm-dd or null — tolerant of Date objects and date strings. */
export function iso(d: unknown): string | null {
  if (!d) return null;
  const t = new Date(d as string);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}

export function maskPhone(phone: string): string {
  const raw = String(phone || '').replace(/\D/g, '').slice(-10);
  return raw.length >= 4 ? '••••••' + raw.slice(-4) : '•••';
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.replace(/^(.).*@/, (_, f: string) => f + '***@');
}

/** Customer-facing statement display cutoff ⚙ (aggregates always full). */
export async function statementCutoff(db: Db): Promise<string> {
  const settings = await getSettingsMap(db);
  return String(settings['portal.statement_display_cutoff'] ?? '2026-06-19');
}

/** Zero-padded reference derived from a row id (legacy LH-… / LEAD-… codes
 * lived in dedicated columns; ncd derives them deterministically instead). */
export function pad(n: number | string, width: number): string {
  return String(n).padStart(width, '0');
}

// ─── Token scheme (LA3/LA4 + agent webview) ─────────────────────────────
// Minimal hand-rolled JWT (HMAC-SHA256), byte-compatible with the legacy
// customer-auth implementation. The signing key is derived from the
// integration key so the JWT secret stays separate from the transport key.

export const TOKEN_TTL_SECONDS = 86400; // 24h

function jwtSecret(): Buffer {
  return createHash('sha256').update('lh_ncd_auth:' + config.LOCKERHUB_INTEGRATION_KEY).digest();
}

export interface TokenCustomer { id: number; customer_code: string; full_name: string }

export function signToken(customer: TokenCustomer, sub = 'lh_ncd_auth', ttlSeconds = TOKEN_TTL_SECONDS): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub,
    cid: customer.id,
    ccode: customer.customer_code,
    name: customer.full_name,
    iat: now,
    exp: now + ttlSeconds,
  })).toString('base64url');
  const sig = createHmac('sha256', jwtSecret()).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export interface TokenClaims { sub: string; cid: number; ccode: string; name: string; iat: number; exp: number }

export function verifyToken(token: unknown, sub = 'lh_ncd_auth'):
  { valid: true; claims: TokenClaims } | { valid: false; reason: string } {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { valid: false, reason: 'malformed' };
    const [header, payload, sig] = parts as [string, string, string];
    const expected = createHmac('sha256', jwtSecret()).update(`${header}.${payload}`).digest('base64url');
    if (sig.length !== expected.length) return { valid: false, reason: 'invalid_signature' };
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff !== 0) return { valid: false, reason: 'invalid_signature' };
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
    if (claims.sub !== sub) return { valid: false, reason: 'invalid_signature' };
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now) return { valid: false, reason: 'expired' };
    return { valid: true, claims };
  } catch {
    // Malformed tokens are an expected input class; the 401 is the signal.
    return { valid: false, reason: 'malformed' };
  }
}

export function genOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

// ─── Customer lookups ────────────────────────────────────────────────────

export interface LhCustomerRow {
  id: string | number;
  customer_code: string;
  full_name: string;
  kyc_status: string | null;
  email: string | null;
  phone: string | null;
  creation_status: string | null;
}

/**
 * Customers visible to LockerHub on the phone-lookup endpoints (legacy
 * 2026-06-12 scoping): NCD investors (≥1 application) or LockerHub-synced
 * customers. ncd has no lockerhub_synced_at column — sync provenance is the
 * LOCKERHUB_CUSTOMER_SYNC audit row written by /customers/from-lockerhub.
 */
export async function lockerhubScopedCustomersByPhone(db: Db, phone: string): Promise<LhCustomerRow[]> {
  const { rows } = await db.query<LhCustomerRow>(
    `SELECT c.id, c.customer_code, c.full_name, c.kyc_status, c.email, c.phone, c.creation_status
       FROM customers c
      WHERE ${phoneMatchSql('c.phone')} = $1
        AND c.is_active = TRUE
        AND (
          EXISTS (SELECT 1 FROM applications a WHERE a.customer_id = c.id)
          OR EXISTS (SELECT 1 FROM audit_log al
                      WHERE al.entity_type = 'customers' AND al.entity_id = c.id::text
                        AND al.action = 'LOCKERHUB_CUSTOMER_SYNC')
        )
      ORDER BY c.id ASC`,
    [phone]
  );
  return rows;
}

/** Unscoped active-customer lookup by phone (auth endpoints — legacy parity). */
export async function activeCustomersByPhone(db: Db, phone: string): Promise<LhCustomerRow[]> {
  const { rows } = await db.query<LhCustomerRow>(
    `SELECT c.id, c.customer_code, c.full_name, c.kyc_status, c.email, c.phone, c.creation_status
       FROM customers c
      WHERE ${phoneMatchSql('c.phone')} = $1 AND c.is_active = TRUE
      ORDER BY c.id ASC`,
    [phone]
  );
  return rows;
}

/** Default open series + one of its schemes (locker-deposit landing). */
export async function openSeriesDefaults(db: Db): Promise<{ seriesId: number; schemeId: number } | null> {
  const { rows } = await db.query<{ series_id: string; scheme_id: string | null }>(
    `SELECT s.id AS series_id,
            (SELECT ss.scheme_id FROM series_schemes ss WHERE ss.series_id = s.id ORDER BY ss.scheme_id ASC LIMIT 1) AS scheme_id
       FROM series s
      WHERE s.status = 'Open'
      ORDER BY s.id DESC LIMIT 1`
  );
  const r = rows[0];
  if (!r || r.scheme_id == null) return null;
  return { seriesId: Number(r.series_id), schemeId: Number(r.scheme_id) };
}
