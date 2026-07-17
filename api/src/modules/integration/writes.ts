/**
 * LockerHub façade — customer WRITES (docs/08 §1). Wire shapes byte-compatible
 * with the legacy routes/integration/customer-writes.js + subscriptions.js:
 *
 *   POST /penny-drop                            BAV v3 result shape
 *   POST /customers/from-lockerhub              idempotent profile upsert
 *   POST /customers/:id/profile-update-request  change request → approval queue
 *   POST /subscription-request                  interest lead (L4)
 *   POST /redemption-request                    staff-pickup redemption (L5)
 *   POST /leads                                 public lead push (L6)
 *   POST /subscription-payments/from-lockerhub  funded payment → PendingApproval app
 *   POST /locker-deposits                       locker deposit booked as NCD
 *
 * Every write lands an audit row; ncd-schema mapping compromises are called
 * out inline (and in the cutover report).
 */
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import type { Db } from '../../db/types.js';
import { config } from '../../config.js';
import { asyncHandler } from '../../middleware/error.js';
import { writeAudit } from '../../lib/audit.js';
import { nextCode } from '../../lib/sequences.js';
import { kycProvider } from '../../integrations/kyc/index.js';
import { getSettingsMap } from '../settings/service.js';
import { createApprovalRequest } from '../approvals/service.js';
import { enqueue } from '../notifications/service.js';
import {
  customerFacingStatus, iso, maskPhone, normalisePhone, openSeriesDefaults,
  pad, phoneMatchSql,
} from './shared.js';

export const customerWritesRouter = Router();

// ─── Penny-drop proxy (Decentro BAV v3 shape) ────────────────────────────
customerWritesRouter.post('/penny-drop', asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const account = String(b.account_number ?? b.account ?? '').replace(/\D/g, '');
  const ifsc = String(b.ifsc ?? '').toUpperCase().trim();
  const name = b.name ? String(b.name) : null;
  if (!account) return res.status(400).json({ error: 'account_number required' });
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    return res.json({
      provider: 'local',
      status: 'Invalid',
      ref_id: null,
      name_on_record: null,
      raw: { reason: 'IFSC must be 11 chars in standard format (e.g. SBIN0001234)' },
    });
  }

  const r = await kycProvider().pennyDrop(account, ifsc, name ?? undefined);
  // ncd's provider interface condenses the verdict — re-expand to the v3
  // status vocabulary from the detail text (Mismatch / Pending are detail-
  // encoded by the decentro adapter).
  const status = r.status === 'Verified' ? 'Verified'
    : /name mismatch/i.test(r.detail) ? 'Mismatch'
    : /could not decide|inconclusive|retry later/i.test(r.detail) ? 'Pending'
    : 'Failed';

  const result = {
    ref_id: null,
    decentro_txn_id: null,
    status,
    account_status: null,
    name_on_record: r.holderName ?? null,
    name_match_percentage: null,
    failure_reason: status === 'Verified' ? null : r.detail,
    error_code: null,
    provider: config.KYC_PRIMARY_PROVIDER,
    raw: { detail: r.detail },
  };

  try {
    await writeAudit(getDb(), {
      actorId: null,
      action: 'LOCKERHUB_PENNY_DROP',
      entityType: 'penny_drop',
      entityId: null,
      after: { account_last4: account.slice(-4), ifsc, name_provided: !!name, status, provider: result.provider },
      ip: req.ip,
    });
  } catch (e) { console.warn('[integration] penny-drop audit write failed (non-fatal):', (e as Error).message); }

  res.json(result);
}));

// ─── Customer profile sync from LockerHub self-signup ────────────────────
customerWritesRouter.post('/customers/from-lockerhub', asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const phone = normalisePhone(b.phone);
  if (phone.length < 10) return res.status(400).json({ error: 'phone required (10 digits)' });
  const name = String(b.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  const db = getDb();
  const trigger = b.trigger || 'unknown';
  const updatedFields: string[] = [];
  const settings = await getSettingsMap(db);
  const codeFmt = String(settings['numbering.customer_format'] ?? 'DHN{seq:6}');

  const result = await db.withTx(async (tx) => {
    // 1. Find (PAN first, then phone) or create the customer.
    let found: Array<Record<string, unknown>> = [];
    const pan = String(b.pan ?? '').trim().toUpperCase();
    if (pan) {
      found = (await tx.query<Record<string, unknown>>(
        `SELECT id, customer_code, full_name, kyc_status, pan FROM customers
          WHERE UPPER(TRIM(COALESCE(pan,''))) = $1 ORDER BY id ASC LIMIT 1`, [pan]
      )).rows;
    }
    if (found.length === 0) {
      found = (await tx.query<Record<string, unknown>>(
        `SELECT id, customer_code, full_name, kyc_status, pan FROM customers
          WHERE ${phoneMatchSql('phone')} = $1 ORDER BY id ASC LIMIT 1`, [phone]
      )).rows;
    }

    let customerId: number;
    let customerCode: string;
    let created: boolean;
    const addr = (b.address ?? {}) as Record<string, unknown>;

    if (found.length === 0) {
      // CREATE — LockerHub has already run its own verification flow, so the
      // record lands Approved + active (legacy 2026-06-18 behaviour).
      customerCode = await nextCode(tx, 'customer', codeFmt);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO customers (customer_code, full_name, phone, email, dob, gender, address, city, state,
                                kyc_status, creation_status, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pending','Approved',TRUE) RETURNING id`,
        [
          customerCode, name, phone,
          b.email || null,
          b.dob || null,
          b.gender ? String(b.gender).slice(0, 40) : null,
          // ncd has no `pin` column — fold the pincode into the address line.
          [addr.line1 || null, addr.pincode ? `PIN ${String(addr.pincode).slice(0, 15)}` : null].filter(Boolean).join(', ') || null,
          addr.city || null,
          addr.state || null,
        ]
      );
      customerId = Number(rows[0]!.id);
      created = true;
      updatedFields.push('customer_created');
    } else {
      // MERGE onto the existing customer.
      const cust = found[0]!;
      customerId = Number(cust.id);
      customerCode = String(cust.customer_code);
      created = false;

      const sets: string[] = [];
      const vals: unknown[] = [];
      let p = 1;
      const push = (col: string, val: unknown) => {
        if (val !== undefined && val !== null && val !== '') {
          sets.push(`${col} = $${p++}`);
          vals.push(val);
          updatedFields.push(col);
        }
      };
      push('full_name', name);
      if (b.email) push('email', b.email);
      if (b.dob) push('dob', b.dob);
      if (b.gender) push('gender', String(b.gender).slice(0, 40));
      if (addr.line1) push('address', addr.line1);
      if (addr.city) push('city', addr.city);
      if (addr.state) push('state', addr.state);
      sets.push('updated_at = now()');
      vals.push(customerId);
      await tx.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $${p}`, vals);
    }

    // 2. KYC — append-only; only verified attempts count. ncd has no
    // kyc_records / aadhaar_last4 columns: PAN lands on customers.pan, both-
    // verified elevates kyc_status, doc images land in customer_documents.
    const pendingDocSaves: Array<{ docType: string; base64: string; mime: string }> = [];
    if (b.kyc && Array.isArray(b.kyc.attempts)) {
      let panVerified = false;
      let aadhaarVerified = false;
      for (const attempt of b.kyc.attempts as Array<Record<string, unknown>>) {
        const docType = String(attempt.document_type ?? '').toUpperCase();
        const isVer = String(attempt.status ?? '').toLowerCase() === 'verified';
        if (!['PAN', 'AADHAAR'].includes(docType)) continue;

        if (docType === 'PAN' && attempt.id_number) {
          const newPan = String(attempt.id_number).trim().toUpperCase();
          const cur = (await tx.query<{ pan: string | null }>('SELECT pan FROM customers WHERE id = $1', [customerId])).rows[0];
          const curPan = cur?.pan ?? '';
          const isSynthetic = curPan === '' || curPan.startsWith('LH_') || curPan.startsWith('CGRP_');
          if (isSynthetic && newPan.length >= 10) {
            try {
              await tx.query('UPDATE customers SET pan = $2, updated_at = now() WHERE id = $1', [customerId, newPan]);
              updatedFields.push('pan');
            } catch { /* PAN already belongs to another customer — keep the synthetic one */ }
          }
        }
        if (attempt.photo_base64) {
          pendingDocSaves.push({
            docType: docType === 'AADHAAR' ? 'Aadhaar' : 'PAN',
            base64: String(attempt.photo_base64).replace(/^data:[^;]+;base64,/, ''),
            mime: String(attempt.mime_type ?? 'image/jpeg'),
          });
        }
        if (!isVer) continue;
        if (docType === 'PAN') panVerified = true;
        if (docType === 'AADHAAR') aadhaarVerified = true;
        updatedFields.push(`kyc_${docType.toLowerCase()}_verified`);
      }
      if (panVerified && aadhaarVerified) {
        await tx.query(
          `UPDATE customers SET kyc_status = 'Verified', updated_at = now() WHERE id = $1 AND kyc_status != 'Verified'`,
          [customerId]
        );
        if (!updatedFields.includes('kyc_status')) updatedFields.push('kyc_status');
      }
    }

    // 3. Bank account rotation (customer_bank_accounts; keeps history).
    if (b.bank_account && b.bank_account.account_number) {
      const ba = b.bank_account as Record<string, unknown>;
      const active = (await tx.query<{ id: string; account_number: string }>(
        'SELECT id, account_number FROM customer_bank_accounts WHERE customer_id = $1 AND is_active = TRUE LIMIT 1',
        [customerId]
      )).rows[0];
      const isSame = active && active.account_number === String(ba.account_number);
      if (!isSame) {
        if (active) await tx.query('UPDATE customer_bank_accounts SET is_active = FALSE WHERE id = $1', [active.id]);
        await tx.query(
          `INSERT INTO customer_bank_accounts (customer_id, account_number, ifsc, bank_name, holder_name, penny_drop_status, is_active, verified_at)
           VALUES ($1,$2,$3,$4,$5,'Verified',TRUE, now())
           ON CONFLICT (customer_id, account_number, ifsc)
           DO UPDATE SET is_active = TRUE, penny_drop_status = 'Verified', bank_name = EXCLUDED.bank_name, holder_name = EXCLUDED.holder_name`,
          [customerId, String(ba.account_number), ba.ifsc ?? null, ba.bank_name ?? null, ba.holder_name ?? null]
        );
        updatedFields.push('bank_account');
      }
    }

    // 4. Demat details (ncd: demat_dp_id / demat_client_id; no depository col).
    if (b.demat && (b.demat.dp_id || b.demat.client_id)) {
      const dm = b.demat as Record<string, unknown>;
      const dmSet: string[] = [];
      const dmVals: unknown[] = [];
      let dp = 1;
      if (dm.dp_id) { dmSet.push(`demat_dp_id = $${dp++}`); dmVals.push(String(dm.dp_id).slice(0, 16)); }
      if (dm.client_id) { dmSet.push(`demat_client_id = $${dp++}`); dmVals.push(String(dm.client_id).slice(0, 16)); }
      if (dmSet.length) {
        dmSet.push('updated_at = now()');
        dmVals.push(customerId);
        await tx.query(`UPDATE customers SET ${dmSet.join(', ')} WHERE id = $${dp}`, dmVals);
        updatedFields.push('demat');
      }
    }

    // 5. Nominee upsert (single-nominee assumption; ncd nominees keep
    // name/relationship/dob — no phone/address columns).
    if (b.nominee && b.nominee.name) {
      const nomB = b.nominee as Record<string, unknown>;
      const existingNom = (await tx.query<{ id: string }>(
        'SELECT id FROM nominees WHERE customer_id = $1 ORDER BY id LIMIT 1', [customerId]
      )).rows[0];
      if (existingNom) {
        await tx.query('UPDATE nominees SET full_name = $2, relationship = $3, dob = $4 WHERE id = $1',
          [existingNom.id, nomB.name, nomB.relation ?? null, nomB.dob ?? null]);
      } else {
        await tx.query('INSERT INTO nominees (customer_id, full_name, relationship, dob) VALUES ($1,$2,$3,$4)',
          [customerId, nomB.name, nomB.relation ?? null, nomB.dob ?? null]);
      }
      updatedFields.push('nominee');
    }

    // 6. Audit — also the LockerHub-visibility marker for the phone lookups.
    await writeAudit(tx, {
      actorId: null,
      action: 'LOCKERHUB_CUSTOMER_SYNC',
      entityType: 'customers',
      entityId: customerId,
      after: {
        trigger,
        phone: maskPhone(phone),
        updated_fields: updatedFields,
        lockerhub_application_no: b.lockerhub_application_no ?? null,
      },
      ip: req.ip,
    });

    return { customerId, customerCode, created };
  });

  // Post-TX: persist KYC doc images (file I/O outside the transaction).
  if (b.kyc && Array.isArray(b.kyc.attempts)) {
    const docs = (b.kyc.attempts as Array<Record<string, unknown>>).filter((a) => a.photo_base64);
    for (const attempt of docs) {
      try {
        const docType = String(attempt.document_type ?? '').toUpperCase() === 'AADHAAR' ? 'Aadhaar' : 'PAN';
        const { validateUpload } = await import('../../lib/uploads.js');
        const { buffer, mime } = validateUpload(String(attempt.photo_base64).replace(/^data:[^;]+;base64,/, ''));
        const { saveBuffer } = await import('../../lib/storage.js');
        const filename = `lh-${result.customerId}-${docType.toLowerCase()}.${mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg'}`;
        const { path } = saveBuffer('kyc-docs', filename, buffer);
        await db.query(
          `INSERT INTO customer_documents (customer_id, doc_type, file_path, original_filename, mime, origin)
           VALUES ($1,$2,$3,$4,$5,'dhanamfin')`,
          [result.customerId, docType, path, filename, mime]
        );
        if (!updatedFields.includes(`doc_${docType.toLowerCase()}`)) updatedFields.push(`doc_${docType.toLowerCase()}`);
      } catch (e) {
        console.warn('[LH-KYC-DOC] save failed (non-fatal):', (e as Error).message);
      }
    }
  }

  res.json({
    success: true,
    customer_id: result.customerId,
    customer_code: result.customerCode,
    created: result.created,
    updated_fields: updatedFields,
  });
}));

// ─── Profile-update request → approval queue ─────────────────────────────
// Whitelist per the legacy contract; the whole profile is in scope.
const PROFILE_FIELD_WHITELIST = [
  'full_name', 'date_of_birth',
  'address_line', 'city', 'state', 'pin',
  'phone_primary', 'email',
  'pan', 'aadhaar_last4',
  'depository', 'demat_dp_id', 'demat_client_id',
  'bank_name', 'bank_account_number', 'bank_ifsc', 'bank_beneficiary_name',
  'nominee_full_name', 'nominee_relationship', 'nominee_date_of_birth',
];
// Legacy field name → ncd customers column (fields the customer_correction
// approval callback can auto-apply on final approve).
const NCD_COLUMN_MAP: Record<string, string> = {
  full_name: 'full_name',
  phone_primary: 'phone',
  email: 'email',
  address_line: 'address',
  city: 'city',
  state: 'state',
};

customerWritesRouter.post('/customers/:id/profile-update-request', asyncHandler(async (req, res) => {
  const customerId = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  const reason = String(b.reason ?? '').slice(0, 500) || null;
  const changes = b.changes && typeof b.changes === 'object' ? (b.changes as Record<string, unknown>) : null;
  if (!changes || !Object.keys(changes).length) {
    return res.status(400).json({ error: 'changes object with at least one field is required' });
  }

  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (PROFILE_FIELD_WHITELIST.includes(k) && v !== undefined && v !== null) filtered[k] = v;
  }
  if (!Object.keys(filtered).length) {
    return res.status(400).json({ error: 'No supported fields in the changes payload', supported_fields: PROFILE_FIELD_WHITELIST });
  }

  const db = getDb();
  const cust = (await db.query<{ id: string; customer_code: string; full_name: string }>(
    'SELECT id, customer_code, full_name FROM customers WHERE id = $1 AND is_active = TRUE', [customerId]
  )).rows[0];
  if (!cust) return res.status(404).json({ error: 'Customer not found' });

  const result = await db.withTx(async (tx) => {
    // The approval's auto-apply diff uses ncd column names; the raw filtered
    // payload is preserved on the change-request row for the approver.
    const applyChanges: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(filtered)) {
      const col = NCD_COLUMN_MAP[k];
      if (col) applyChanges[col] = v;
    }
    const approvalReq = await createApprovalRequest(tx, {
      type: 'customer_correction',
      entityType: 'customers',
      entityId: customerId,
      makerUserId: null, // LockerHub-originated (integration key), no staff maker
      metadata: { changes: applyChanges, raw_changes: filtered, reason, source: 'lockerhub' },
    });
    const pcr = (await tx.query<{ id: string; created_at: string }>(
      `INSERT INTO customer_change_requests (customer_id, changes, reason, source, approval_request_id)
       VALUES ($1,$2,$3,'lockerhub',$4) RETURNING id, created_at`,
      [customerId, JSON.stringify(filtered), reason, approvalReq.id]
    )).rows[0]!;
    await writeAudit(tx, {
      actorId: null,
      action: 'LOCKERHUB_PROFILE_UPDATE_REQUEST',
      entityType: 'customers',
      entityId: customerId,
      after: { fields: Object.keys(filtered), approval_request_id: approvalReq.id },
      ip: req.ip,
    });
    return { pcrId: Number(pcr.id), approvalId: approvalReq.id };
  });

  res.status(201).json({
    ok: true,
    // Legacy stored PCR-… in its own table; ncd derives it from the row id.
    request_no: `PCR-${new Date().getUTCFullYear()}-${pad(result.pcrId, 6)}`,
    status: 'PendingApproval',
    approval_request_id: result.approvalId,
    message: 'Profile change submitted for approval.  ' +
             'The customer record will update once a Wealth admin signs off.',
  });
}));

// ─── Helpers shared by the lead/subscription writes ──────────────────────

/** Legacy lead_no lived in a column; derive the same LEAD-YYYYMM-NNNNN look
 * deterministically from the row id + created month. */
function leadRef(id: number | string, createdAt: unknown): string {
  const d = iso(createdAt) ?? new Date().toISOString().slice(0, 10);
  return `LEAD-${d.slice(0, 4)}${d.slice(5, 7)}-${pad(String(id), 5)}`;
}

async function findActiveCustomer(db: Db, customerId: number | null, phone: string) {
  if (customerId != null && Number.isInteger(customerId)) {
    const { rows } = await db.query<Record<string, unknown>>(
      'SELECT id, customer_code, full_name, phone, email, kyc_status FROM customers WHERE id = $1 AND is_active = TRUE',
      [customerId]
    );
    if (rows[0]) return rows[0];
  }
  if (phone.length === 10) {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT id, customer_code, full_name, phone, email, kyc_status FROM customers
        WHERE ${phoneMatchSql('phone')} = $1 AND is_active = TRUE ORDER BY id ASC LIMIT 1`,
      [phone]
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

// ─── L4 · Subscription interest request → investor lead ─────────────────
customerWritesRouter.post('/subscription-request', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  let customerId = body.customer_id ? parseInt(String(body.customer_id), 10) : null;
  const customerPhone = normalisePhone(body.phone ?? body.customer_phone ?? '');
  const customerName = String(body.name ?? body.full_name ?? body.customer_name ?? '').trim();
  const seriesId = parseInt(String(body.series_id), 10);
  const schemeId = body.scheme_id ? parseInt(String(body.scheme_id), 10) : null;
  const requestedAmount = Number(body.requested_amount);
  const notes = String(body.notes ?? '');
  const lhAppNo = String(body.lockerhub_application_no ?? '').trim() || null;

  if (!Number.isInteger(seriesId)) {
    return res.json({ success: false, skipped: true, reason: 'series_id not mapped in LockerHub — no action taken' });
  }
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return res.status(400).json({ error: 'requested_amount must be > 0' });
  }
  if (requestedAmount > 1_000_000_000_00) {
    return res.status(400).json({ error: 'requested_amount out of range (max ₹100 Cr)' });
  }

  const db = getDb();
  let cust = await findActiveCustomer(db, customerId, customerPhone);
  if (cust) customerId = Number(cust.id);
  if (!cust) {
    if (!customerPhone && !customerName) return res.status(400).json({ error: 'customer_id, phone, or name required' });
    cust = { id: null, full_name: customerName || 'Phone ' + customerPhone, phone: customerPhone || null, email: body.email ?? null };
  }

  const series = (await db.query<Record<string, unknown>>('SELECT id, code, name, status FROM series WHERE id = $1', [seriesId])).rows[0];
  if (!series) return res.status(404).json({ error: 'Series not found' });
  if (series.status !== 'Open') return res.status(400).json({ error: `Series ${series.code} is not open for subscription` });

  let schemeName: string | null = null;
  if (schemeId) {
    const sch = (await db.query<{ name: string }>('SELECT name FROM schemes WHERE id = $1', [schemeId])).rows[0];
    if (sch) schemeName = sch.name;
  }
  const interestedSchemeLabel = String(series.name || series.code) + (schemeName ? ' — ' + schemeName : '');
  const fullNotes = (notes ? notes + ' ' : '') + '[via LockerHub portal]';

  // Dedup — the stable per-investment key first, else legacy customer+series.
  const dup = lhAppNo
    ? (await db.query<Record<string, unknown>>(
        'SELECT id, created_at FROM investor_leads WHERE lockerhub_application_no = $1 LIMIT 1', [lhAppNo]
      )).rows[0]
    : (await db.query<Record<string, unknown>>(
        `SELECT id, created_at FROM investor_leads
          WHERE source = 'LockerHub Web' AND notes LIKE '%[via LockerHub portal]%'
            AND interested_scheme = $1 AND lockerhub_application_no IS NULL
            AND (full_name = $2 OR ${phoneMatchSql('phone')} = $3)
          ORDER BY created_at DESC LIMIT 1`,
        [interestedSchemeLabel, cust.full_name, normalisePhone(cust.phone)]
      )).rows[0];
  if (dup) {
    return res.json({ success: true, reference_id: leadRef(String(dup.id), dup.created_at), lead_id: Number(dup.id), already_exists: true });
  }

  // ncd's investor_leads has no email / interested_series_id / lead_no columns —
  // the series is encoded in interested_scheme, the reference is id-derived.
  const lead = (await db.query<{ id: string; created_at: string }>(
    `INSERT INTO investor_leads (full_name, phone, source, interested_scheme, expected_amount, notes, status, admin_only, lockerhub_application_no)
     VALUES ($1,$2,'LockerHub Web',$3,$4,$5,'Interested',FALSE,$6) RETURNING id, created_at`,
    [cust.full_name, cust.phone ?? null, interestedSchemeLabel, requestedAmount, fullNotes, lhAppNo]
  )).rows[0]!;

  await writeAudit(db, {
    actorId: null,
    action: 'LOCKERHUB_SUBSCRIPTION_REQUEST',
    entityType: 'investor_leads',
    entityId: Number(lead.id),
    after: { customer_id: customerId, series_id: seriesId, requested_amount: requestedAmount, lockerhub_application_no: lhAppNo },
    ip: req.ip,
  });

  res.json({ success: true, reference_id: leadRef(lead.id, lead.created_at), lead_id: Number(lead.id) });
}));

// ─── L5 · Redemption request → staff queue ───────────────────────────────
customerWritesRouter.post('/redemption-request', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const customerId = parseInt(String(body.customer_id), 10);
  const applicationNo = body.application_no;
  const notes = String(body.notes ?? '');

  if (!Number.isInteger(customerId)) return res.status(400).json({ error: 'customer_id required' });
  if (!applicationNo) return res.status(400).json({ error: 'application_no required' });

  const db = getDb();
  const app = (await db.query<Record<string, unknown>>(
    `SELECT a.id, a.application_no, a.status, a.customer_id, a.maturity_date,
            MIN(al.maturity_date) AS line_maturity_min
       FROM applications a LEFT JOIN application_lines al ON al.application_id = a.id
      WHERE a.application_no = $1
      GROUP BY a.id`,
    [applicationNo]
  )).rows[0];
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (Number(app.customer_id) !== customerId) {
    // Don't leak whether the app belongs to a different customer.
    return res.status(404).json({ error: 'Application not found' });
  }
  if (app.status !== 'Active') {
    return res.status(400).json({ error: `Application is not eligible for redemption — current status: ${app.status}` });
  }
  const matIso = iso(app.line_maturity_min ?? app.maturity_date);
  if (matIso && matIso > new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({
      error: `Application is not eligible for redemption — maturity date ${matIso} not reached. Premature redemption requires in-person processing.`,
    });
  }

  // Dedup — one open request per application.
  const dup = (await db.query<Record<string, unknown>>(
    `SELECT id, created_at FROM redemptions WHERE application_id = $1 AND status IN ('Requested','Approved')
      ORDER BY created_at DESC LIMIT 1`,
    [app.id]
  )).rows[0];
  if (dup) {
    const year = (iso(dup.created_at) ?? new Date().toISOString()).slice(0, 4);
    return res.status(409).json({
      error: 'Redemption request already pending for this application',
      reference_id: `LH-RDM-${year}-${pad(String(dup.id), 6)}`,
    });
  }

  // Lands in ncd's staff redemptions queue (the PendingStaffPickup equivalent).
  const { requestRedemption } = await import('../redemptions/service.js');
  const r = await requestRedemption(db, { applicationId: Number(app.id), reason: notes || 'App request', source: 'lockerhub' });
  const ref = `LH-RDM-${new Date().getUTCFullYear()}-${pad(r.id, 6)}`;

  await writeAudit(db, {
    actorId: null,
    action: 'LOCKERHUB_REDEMPTION_REQUEST',
    entityType: 'redemptions',
    entityId: r.id,
    after: { lockerhub_ref: ref, customer_id: customerId, application_no: applicationNo },
    ip: req.ip,
  });

  res.json({ success: true, reference_id: ref });
}));

// ─── L6 · NCD lead push from the LockerHub public portal ─────────────────
customerWritesRouter.post('/leads', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const name = String(body.name ?? body.full_name ?? '').trim();
  const phone = normalisePhone(body.phone ?? '');
  const place = body.place ?? null;
  const intScheme = body.interested_scheme ?? null;
  const expectedAmt = body.expected_amount != null ? Number(body.expected_amount) : null;
  const notes = body.notes ?? null;
  const sourceRaw = String(body.source ?? '').toLowerCase();

  if (!name) return res.status(400).json({ error: 'name is required' });
  if (phone.length < 10) return res.status(400).json({ error: 'phone must be at least 10 digits' });

  let source = 'LockerHub Web';
  if (sourceRaw === 'lockerhub_mobile' || sourceRaw === 'lockerhub mobile') source = 'LockerHub Mobile';
  else if (sourceRaw === 'lockerhub_web' || sourceRaw === 'lockerhub web') source = 'LockerHub Web';
  else if (sourceRaw && !['lockerhub_web', 'lockerhub_mobile'].includes(sourceRaw)) {
    return res.status(400).json({ error: `source must be 'lockerhub_web' or 'lockerhub_mobile' (got '${body.source}')` });
  }

  const db = getDb();
  const dup = (await db.query<Record<string, unknown>>(
    `SELECT id, created_at FROM investor_leads WHERE ${phoneMatchSql('phone')} = $1 ORDER BY id ASC LIMIT 1`,
    [phone]
  )).rows[0];
  if (dup) {
    return res.json({
      success: false,
      duplicate: true,
      message: 'Lead with this phone already exists',
      lead_id: Number(dup.id),
      reference_id: leadRef(String(dup.id), dup.created_at),
    });
  }

  // ncd's investor_leads has no email column — email is not persisted.
  const lead = (await db.query<{ id: string; created_at: string }>(
    `INSERT INTO investor_leads (full_name, phone, place, source, interested_scheme, expected_amount, notes, status, admin_only, lockerhub_application_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'New',FALSE,$8) RETURNING id, created_at`,
    [name, phone, place, source, intScheme, expectedAmt, notes, String(body.lockerhub_application_no ?? '').trim() || null]
  )).rows[0]!;

  await writeAudit(db, {
    actorId: null,
    action: 'LOCKERHUB_LEAD_PUSH',
    entityType: 'investor_leads',
    entityId: Number(lead.id),
    after: { source, phone: maskPhone(phone) },
    ip: req.ip,
  });

  res.json({ success: true, lead_id: Number(lead.id), reference_id: leadRef(lead.id, lead.created_at) });
}));

// ─── Funded-payment landing + locker deposits ────────────────────────────

interface LandInput {
  intentNo: string;
  phone: string;
  customerName: string;
  seriesId: number | null;
  seriesCode: string | null;
  schemeId: number | null;
  schemeCode: string | null;
  amount: number;
  paidAt: string;
  collectionReference: string;
  isLockerDeposit: boolean;
  referredBy: string | null;
  ip?: string;
  auditAction: string;
  auditExtra: Record<string, unknown>;
}

/** Create the PendingApproval application (+line) for a funded LockerHub
 * payment. Idempotency is the caller's concern. Returns app id + number. */
async function landFundedApplication(db: Db, b: LandInput): Promise<{ appId: number; appNo: string; customerId: number }> {
  return db.withTx(async (tx) => {
    // Customer — by phone; auto-create a Draft stub if unknown (money must
    // never bounce into a 404 retry loop).
    let customer = (await tx.query<Record<string, unknown>>(
      `SELECT id, customer_code FROM customers WHERE ${phoneMatchSql('phone')} = $1 AND is_active = TRUE ORDER BY id ASC LIMIT 1`,
      [b.phone]
    )).rows[0];
    if (!customer) {
      if (b.phone.length < 10) {
        throw Object.assign(new Error('Customer not found AND customer_phone is invalid — cannot create stub'), { status: 400 });
      }
      const settings = await getSettingsMap(tx);
      const codeFmt = String(settings['numbering.customer_format'] ?? 'DHN{seq:6}');
      const newCode = await nextCode(tx, 'customer', codeFmt);
      const stubName = b.customerName || 'LockerHub ' + b.phone;
      const stubPan = 'LH_' + b.phone; // synthetic; replaced when KYC completes
      customer = (await tx.query<Record<string, unknown>>(
        `INSERT INTO customers (customer_code, full_name, phone, pan, kyc_status, creation_status, is_active)
         VALUES ($1,$2,$3,$4,'Pending','Draft',TRUE) RETURNING id, customer_code`,
        [newCode, stubName, b.phone, stubPan]
      )).rows[0]!;
    }
    const customerId = Number(customer.id);

    // Series + scheme (numeric ids per the live contract; code fallback kept
    // for the earlier ncd-side callers).
    const series = b.seriesId != null
      ? (await tx.query<Record<string, unknown>>('SELECT id, code FROM series WHERE id = $1', [b.seriesId])).rows[0]
      : b.seriesCode
        ? (await tx.query<Record<string, unknown>>('SELECT id, code FROM series WHERE code = $1', [b.seriesCode])).rows[0]
        : undefined;
    if (!series) throw Object.assign(new Error('Series not found'), { status: 404 });
    const scheme = b.schemeId != null
      ? (await tx.query<Record<string, unknown>>('SELECT * FROM schemes WHERE id = $1', [b.schemeId])).rows[0]
      : b.schemeCode
        ? (await tx.query<Record<string, unknown>>('SELECT * FROM schemes WHERE code = $1', [b.schemeCode])).rows[0]
        : undefined;
    if (!scheme) throw Object.assign(new Error('Scheme not found'), { status: 404 });
    const linked = await tx.query('SELECT 1 FROM series_schemes WHERE series_id = $1 AND scheme_id = $2', [series.id, scheme.id]);
    if (!linked.rowCount) {
      throw Object.assign(new Error(`Scheme ${scheme.code} is not linked to series ${series.code}`), { status: 400 });
    }

    const appNo = await nextCode(tx, 'application', 'APP-{yyyy}-{seq:6}');
    const priorCount = Number((await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM applications WHERE customer_id = $1', [customerId]
    )).rows[0]!.n);

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, amount_received,
                                 date_money_received, interest_start_date, collection_method, collection_reference,
                                 customer_was_new_at_creation, is_locker_deposit, lockerhub_intent_no, referred_by_text, source)
       VALUES ($1,$2,$3,'PendingApproval',$4,$4,$5::date,$5::date,'Other',$6,$7,$8,$9,$10,'dhanamfin') RETURNING id`,
      [appNo, customerId, series.id, b.amount, b.paidAt, b.collectionReference, priorCount === 0,
       b.isLockerDeposit, b.intentNo, b.referredBy]
    );
    const appId = Number(rows[0]!.id);
    await tx.query(
      `INSERT INTO application_lines (application_id, scheme_id, coupon_rate_pct, tenure_months, payout_frequency, day_count_convention, amount, outstanding_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'Active')`,
      [appId, scheme.id, scheme.coupon_rate_pct, scheme.tenure_months, scheme.payout_frequency, scheme.day_count_convention, b.amount]
    );

    await writeAudit(tx, {
      actorId: null,
      action: b.auditAction,
      entityType: 'applications',
      entityId: appId,
      after: { application_no: appNo, lockerhub_intent_no: b.intentNo, amount: b.amount, paid_at: b.paidAt, ...b.auditExtra },
      ip: b.ip,
    });

    return { appId, appNo, customerId };
  });
}

/** Fire-and-forget operator alert for a landed LockerHub application. */
async function notifyOperators(db: Db, appNo: string, amount: number, customerId: number): Promise<void> {
  try {
    const cust = (await db.query<{ full_name: string; customer_code: string }>(
      'SELECT full_name, customer_code FROM customers WHERE id = $1', [customerId]
    )).rows[0];
    const { rows: recipients } = await db.query<{ email: string }>(
      `SELECT DISTINCT u.email FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.is_active = TRUE AND u.email IS NOT NULL AND u.email <> ''
          AND r.name = ANY($1::text[])`,
      [['super_admin', 'admin', 'ncd_manager', 'cxo']]
    );
    for (const r of recipients) {
      await enqueue(db, {
        channel: 'email',
        template: 'lockerhub_investment_landed',
        to: r.email,
        payload: {
          customer_name: cust?.full_name ?? '',
          customer_code: cust?.customer_code ?? '',
          amount: amount.toFixed(2),
          application_no: appNo,
        },
      });
    }
  } catch (e) {
    console.warn('[lockerhub-payment] alert email skipped:', (e as Error).message);
  }
}

// POST /subscription-payments/from-lockerhub — Easebuzz-verified money landed.
customerWritesRouter.post('/subscription-payments/from-lockerhub', asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const intentNo = b.lockerhub_intent_no;
  const phone = normalisePhone(b.customer_phone ?? b.phone ?? '');
  const seriesId = b.series_id != null && b.series_id !== '' ? parseInt(String(b.series_id), 10) : null;
  const schemeId = b.scheme_id != null && b.scheme_id !== '' ? parseInt(String(b.scheme_id), 10) : null;
  const amount = b.amount != null ? Number(b.amount) : null;
  const isPlaceholder = b.is_placeholder === true;

  if (!intentNo) return res.status(400).json({ error: 'lockerhub_intent_no required' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required and must be > 0' });

  const db = getDb();

  // Idempotent on lockerhub_intent_no (falls back to collection_reference).
  const existing = (await db.query<{ application_no: string }>(
    'SELECT application_no FROM applications WHERE lockerhub_intent_no = $1 OR collection_reference = $1 LIMIT 1',
    [intentNo]
  )).rows[0];
  if (existing) {
    return res.json({
      success: true,
      already_processed: true,
      wealth_subscription_id: existing.application_no,
      wealth_subscription_request_id: existing.application_no,
    });
  }
  if (seriesId == null && !b.series_code) return res.status(400).json({ error: 'series_id required' });
  if (schemeId == null && !b.scheme_code) return res.status(400).json({ error: 'scheme_id required' });

  let landed: { appId: number; appNo: string; customerId: number };
  try {
    landed = await landFundedApplication(db, {
      intentNo: String(intentNo),
      phone,
      customerName: String(b.customer_name ?? '').trim(),
      seriesId,
      seriesCode: b.series_code ? String(b.series_code) : null,
      schemeId,
      schemeCode: b.scheme_code ? String(b.scheme_code) : null,
      amount,
      paidAt: iso(b.paid_at) ?? new Date().toISOString().slice(0, 10),
      collectionReference: String(b.provider_ref || intentNo),
      isLockerDeposit: b.is_locker_deposit === true,
      referredBy: typeof b.referred_by === 'string' ? b.referred_by.trim() || null : null,
      ip: req.ip,
      auditAction: 'LOCKERHUB_PAYMENT_RECEIVED',
      auditExtra: {
        lockerhub_application_no: b.lockerhub_application_no ?? null,
        provider: b.provider || 'easebuzz',
        provider_ref: b.provider_ref ?? null,
        is_placeholder: isPlaceholder,
      },
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    throw e;
  }

  // Reconcile the earlier un-funded interest lead (best-effort, post-commit).
  if (b.lockerhub_application_no) {
    try {
      await db.query(
        `UPDATE investor_leads SET status = 'Converted', converted_customer_id = $1, updated_at = now()
          WHERE lockerhub_application_no = $2 AND status <> 'Converted'`,
        [landed.customerId, b.lockerhub_application_no]
      );
    } catch (e) { console.warn('[lockerhub-payment] lead reconcile skipped:', (e as Error).message); }
  }

  await notifyOperators(db, landed.appNo, amount, landed.customerId);

  res.json({
    success: true,
    wealth_subscription_id: landed.appNo,
    wealth_subscription_request_id: landed.appNo,
    is_placeholder: isPlaceholder,
    customer_id: landed.customerId,
  });
}));

// POST /locker-deposits — a paid locker deposit is booked as an NCD (docs/08).
// LockerHub payload: { customer_id?, pan, phone, name, deposit_amount,
// deposit_date, deposit_reference, locker_no, branch, requires_approval,
// source_flag }. It then polls /ncd/locker-deposit-status?deposit_reference=.
customerWritesRouter.post('/locker-deposits', asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const ref = String(b.deposit_reference ?? '').trim();
  const phone = normalisePhone(b.phone ?? '');
  const amount = b.deposit_amount != null ? Number(b.deposit_amount) : null;
  if (!ref) return res.status(400).json({ error: 'deposit_reference required' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'deposit_amount required and must be > 0' });
  if (phone.length < 10) return res.status(400).json({ error: 'phone required (10 digits)' });

  const db = getDb();
  const existing = (await db.query<{ application_no: string; status: string }>(
    'SELECT application_no, status FROM applications WHERE lockerhub_intent_no = $1 LIMIT 1', [ref]
  )).rows[0];
  if (existing) {
    return res.json({
      success: true,
      already_processed: true,
      ncd_id: existing.application_no,
      approval_status: existing.status === 'PendingApproval' ? 'pending_approval'
        : (existing.status === 'Rejected' || existing.status === 'Cancelled') ? 'rejected' : 'registered',
    });
  }

  // Deposits carry no series/scheme — land them on the open series' default
  // scheme (same rule as the legacy auto-recovery cron). No open series →
  // 503 so LockerHub's durable queue retries.
  const def = await openSeriesDefaults(db);
  if (!def) return res.status(503).json({ error: 'No open NCD series to host the locker deposit' });

  let landed: { appId: number; appNo: string; customerId: number };
  try {
    landed = await landFundedApplication(db, {
      intentNo: ref,
      phone,
      customerName: String(b.name ?? '').trim(),
      seriesId: def.seriesId,
      seriesCode: null,
      schemeId: def.schemeId,
      schemeCode: null,
      amount,
      paidAt: iso(b.deposit_date) ?? new Date().toISOString().slice(0, 10),
      collectionReference: ref,
      isLockerDeposit: true,
      referredBy: null,
      ip: req.ip,
      auditAction: 'LOCKERHUB_LOCKER_DEPOSIT_RECEIVED',
      auditExtra: {
        pan_last4: String(b.pan ?? '').slice(-4) || null,
        locker_no: b.locker_no ?? null,
        branch: b.branch ?? null,
        source_flag: b.source_flag ?? null,
      },
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    throw e;
  }

  await notifyOperators(db, landed.appNo, amount, landed.customerId);

  res.status(201).json({
    success: true,
    ncd_id: landed.appNo,
    approval_status: 'pending_approval',
    customer_id: landed.customerId,
    customer_status: customerFacingStatus('PendingApproval', false),
  });
}));
