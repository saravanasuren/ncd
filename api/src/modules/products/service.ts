/** Products/masters service — schemes, series, TDS rules, banks, holidays,
 * company profile (docs/04 §2). All writes audited + status-machine guarded. */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { assertTransition } from '../../lib/statusMachine.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';

// ── Schemes ──
export async function listSchemes(db: Db) {
  return (await db.query('SELECT * FROM schemes ORDER BY code')).rows;
}
export async function createScheme(db: Db, actor: AuthUser, s: Record<string, unknown>) {
  return db.withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO schemes (code, name, tenure_months, payout_frequency, coupon_rate_pct, face_value, min_ticket, multiple_of, day_count_convention, commission_rule, tds_rule_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [s.code, s.name, s.tenure_months, s.payout_frequency ?? 'Monthly', s.coupon_rate_pct,
       s.face_value ?? 100000, s.min_ticket ?? 100000, s.multiple_of ?? 100000,
       s.day_count_convention ?? 'Actual365', s.commission_rule ?? 'OneTime', s.tds_rule_id ?? null]
    );
    const id = Number(rows[0]!.id);
    await writeAudit(tx, { actorId: actor.id, action: 'scheme.create', entityType: 'schemes', entityId: id, after: s });
    return { id };
  });
}
export async function updateScheme(db: Db, actor: AuthUser, id: number, s: Record<string, unknown>) {
  const fields = ['name', 'tenure_months', 'payout_frequency', 'coupon_rate_pct', 'face_value', 'min_ticket', 'multiple_of', 'day_count_convention', 'commission_rule', 'tds_rule_id', 'is_active'];
  await genericUpdate(db, actor, 'schemes', id, s, fields, 'scheme.update');
}

// ── Series ──
export async function listSeries(db: Db) {
  return (await db.query('SELECT * FROM series ORDER BY code')).rows;
}
/** A series that has not been approved yet. It exists, it is visible in
 *  Masters, and it CANNOT take investments (owner 2026-08-19). */
export const SERIES_PENDING = 'PendingApproval';

/**
 * Create a series → approval (owner 2026-08-19: "once a series is created it
 * should go by approval").
 *
 * It lands in PendingApproval rather than Open. The enrolment dropdown only
 * offers Open series and `assertSeriesTakesMoney` refuses a pending one, so a
 * mistyped rate or deemed date cannot take a rupee before a second person has
 * looked at it. Approval flips it to Open and stamps opened_at — the moment the
 * series actually opened, not the moment someone typed it.
 */
export async function createSeries(db: Db, actor: AuthUser, s: Record<string, unknown>) {
  return db.withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO series (code, name, status, face_value, deemed_date, opened_at)
       VALUES ($1,$2,$5,$3,$4, NULL) RETURNING id`,
      [s.code, s.name, s.face_value ?? null, s.deemed_date ?? null, SERIES_PENDING]
    );
    const id = Number(rows[0]!.id);
    // link schemes if provided
    if (Array.isArray(s.scheme_ids)) {
      for (const sid of s.scheme_ids as number[]) {
        await tx.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, sid]);
      }
    }
    const req = await createApprovalRequest(tx, {
      type: 'series_creation', entityType: 'series', entityId: id, makerUserId: actor.id,
      metadata: { code: s.code, name: s.name, deemed_date: s.deemed_date ?? null },
    });
    await writeAudit(tx, { actorId: actor.id, action: 'series.create', entityType: 'series', entityId: id, after: { ...s, status: SERIES_PENDING } });
    return { id, status: SERIES_PENDING, approval_request: req };
  });
}

registerOnFinalApprove('series_creation', async (tx, req) => {
  if (!req.entity_id) return;
  await tx.query(
    "UPDATE series SET status = 'Open', opened_at = COALESCE(opened_at, now()) WHERE id = $1 AND status = $2",
    [Number(req.entity_id), SERIES_PENDING]);
});

registerOnReject('series_creation', async (tx, req) => {
  // A rejected series is withdrawn, not deleted: the row is referenced by the
  // approval trail, and a deleted one would leave a request pointing at nothing.
  if (!req.entity_id) return;
  await tx.query("UPDATE series SET status = 'Withdrawn' WHERE id = $1 AND status = $2",
    [Number(req.entity_id), SERIES_PENDING]);
});

/** What a series edit may change. Status, ISIN and the timestamps have their
 *  own dedicated actions and stay out of it. */
const SERIES_EDITABLE = ['code', 'name', 'face_value', 'deemed_date'] as const;

/**
 * Edit a series → approval (owner 2026-08-19: edits need a checker too).
 *
 * A live series has money in it: its deemed date and face value are printed on
 * documents and feed interest, so changing one on a whim is exactly the kind of
 * thing a second pair of eyes exists for. The request carries only the fields
 * that actually differ, so a checker sees the change and not the whole record.
 */
export async function requestSeriesChange(db: Db, actor: AuthUser, seriesId: number, input: Record<string, unknown>) {
  const cur = (await db.query<Record<string, unknown>>(
    'SELECT id, code, name, face_value, deemed_date, status FROM series WHERE id = $1', [seriesId])).rows[0];
  if (!cur) throw errors.notFound('Series not found');

  const changes: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  for (const k of SERIES_EDITABLE) {
    if (!(k in input)) continue;
    const next = input[k] === '' ? null : input[k];
    // Compare as strings: face_value comes back from the driver as '100000.00'
    // and a numeric 100000 typed in the form is the same value, not an edit.
    const same = String(cur[k] ?? '') === String(next ?? '')
      || (k === 'deemed_date' && String(cur[k] ?? '').slice(0, 10) === String(next ?? '').slice(0, 10));
    if (!same) { changes[k] = next; before[k] = cur[k] ?? null; }
  }
  if (!Object.keys(changes).length) throw errors.badRequest('No changes to submit');

  return db.withTx(async (tx) => {
    const req = await createApprovalRequest(tx, {
      type: 'series_change', entityType: 'series', entityId: seriesId, makerUserId: actor.id,
      metadata: { changes, before, code: cur.code },
    });
    await writeAudit(tx, { actorId: actor.id, action: 'series.change-request', entityType: 'series', entityId: seriesId, before, after: changes });
    return { ok: true, applied: false, approval_request: req };
  });
}

registerOnFinalApprove('series_change', async (tx, req) => {
  const changes = (req.metadata.changes ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  for (const k of SERIES_EDITABLE) {
    if (!(k in changes)) continue;
    sets.push(`${k} = $${++p}`); // key comes from SERIES_EDITABLE, never the request
    params.push(changes[k] ?? null);
  }
  if (sets.length && req.entity_id) {
    params.push(Number(req.entity_id));
    await tx.query(`UPDATE series SET ${sets.join(', ')} WHERE id = $${++p}`, params);
  }
});

/**
 * Refuse money into a series nobody has approved yet. Deliberately narrow: it
 * bites ONLY on PendingApproval, so imports, rollovers and app-channel money
 * still land in Closing/Allotted series exactly as before.
 */
export async function assertSeriesTakesMoney(db: Db, seriesId: number) {
  const row = (await db.query<{ status: string; code: string }>(
    'SELECT status, code FROM series WHERE id = $1', [seriesId])).rows[0];
  if (row && row.status === SERIES_PENDING) {
    throw errors.badRequest(`Series ${row.code} is waiting for approval — it cannot take investments until a checker approves it`);
  }
}
export async function setSeriesStatus(db: Db, actor: AuthUser, id: number, to: string) {
  await db.withTx(async (tx) => {
    const cur = await tx.query<{ status: string }>('SELECT status FROM series WHERE id = $1', [id]);
    if (!cur.rows[0]) throw errors.notFound('Series not found');
    assertTransition('series', cur.rows[0].status, to);
    await tx.query('UPDATE series SET status = $1 WHERE id = $2', [to, id]);
    await writeAudit(tx, { actorId: actor.id, action: 'series.status', entityType: 'series', entityId: id, before: cur.rows[0], after: { status: to } });
  });
}
export async function setSeriesIsin(db: Db, actor: AuthUser, id: number, isin: string) {
  await db.query('UPDATE series SET isin = $1 WHERE id = $2', [isin, id]);
  await writeAudit(db, { actorId: actor.id, action: 'series.isin', entityType: 'series', entityId: id, after: { isin } });
}

// ── Subordinate Bond products (owner spec 2026-08-10) ──
//
// The sub-bond equivalent of a scheme. A subordinate bond belongs to no series,
// so there is no scheme to carry its rate — the owner chose a product master
// over per-investment rates so a rate change is one edit, and two customers on
// the same product cannot silently end up on different rates.
//
// No min_ticket / multiple_of here on purpose: the owner confirmed subordinate
// bonds carry NO whole-₹1,00,000 unit rule (unlike NCDs).
export async function listSobProducts(db: Db) {
  return (await db.query('SELECT * FROM sob_products ORDER BY code')).rows;
}
export async function createSobProduct(db: Db, actor: AuthUser, s: Record<string, unknown>) {
  const code = String(s.code ?? '').trim();
  const name = String(s.name ?? '').trim();
  const tenure = Number(s.tenure_months);
  const rate = Number(s.coupon_rate_pct);
  if (!code) throw errors.badRequest('Code is required');
  if (!name) throw errors.badRequest('Name is required');
  if (!Number.isInteger(tenure) || tenure <= 0) throw errors.badRequest('Tenure must be a whole number of months');
  // A zero-rate bond pays no interest, which is far more likely to be a slip
  // than an intention — and it would generate a schedule of ₹0 payouts.
  if (!Number.isFinite(rate) || rate <= 0) throw errors.badRequest('Interest rate must be greater than zero');
  return db.withTx(async (tx) => {
    const dup = (await tx.query('SELECT id FROM sob_products WHERE upper(code) = upper($1)', [code])).rows[0];
    if (dup) throw errors.conflict(`A subordinate bond product with code ${code} already exists`);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO sob_products (code, name, tenure_months, payout_frequency, coupon_rate_pct, day_count_convention, tds_rule_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [code, name, tenure, s.payout_frequency ?? 'Monthly', rate,
       s.day_count_convention ?? 'Actual365', s.tds_rule_id ?? null]
    );
    const id = Number(rows[0]!.id);
    await writeAudit(tx, { actorId: actor.id, action: 'sob_product.create', entityType: 'sob_products', entityId: id, after: s });
    return { id };
  });
}
export async function updateSobProduct(db: Db, actor: AuthUser, id: number, s: Record<string, unknown>) {
  // `code` is deliberately NOT updatable — investments are read and reconciled
  // by it, exactly as a scheme's code is fixed once issued.
  const fields = ['name', 'tenure_months', 'payout_frequency', 'coupon_rate_pct', 'day_count_convention', 'tds_rule_id', 'is_active'];
  await genericUpdate(db, actor, 'sob_products', id, s, fields, 'sob_product.update');
}

// ── TDS rules ──
export async function listTdsRules(db: Db) {
  return (await db.query('SELECT * FROM tds_rules ORDER BY name')).rows;
}
export async function createTdsRule(db: Db, actor: AuthUser, r: Record<string, unknown>) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO tds_rules (name, kind, rate_pct, threshold) VALUES ($1,$2,$3,$4) RETURNING id`,
    [r.name, r.kind ?? 'standard', r.rate_pct ?? 10, r.threshold ?? null]
  );
  const id = Number(rows[0]!.id);
  await writeAudit(db, { actorId: actor.id, action: 'tds_rule.create', entityType: 'tds_rules', entityId: id, after: r });
  return { id };
}

// ── Banks ──
export async function listBanks(db: Db) {
  return (await db.query('SELECT * FROM banks ORDER BY account_label')).rows;
}
export async function createBank(db: Db, actor: AuthUser, b: Record<string, unknown>) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO banks (account_label, bank_name, account_number, ifsc, is_collection_account, is_disbursement_account)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [b.account_label, b.bank_name, b.account_number ?? null, b.ifsc ?? null, b.is_collection_account ?? false, b.is_disbursement_account ?? false]
  );
  const id = Number(rows[0]!.id);
  await writeAudit(db, { actorId: actor.id, action: 'bank.create', entityType: 'banks', entityId: id, after: b });
  return { id };
}

// ── Holidays ──
export async function listHolidays(db: Db) {
  return (await db.query('SELECT * FROM holidays ORDER BY d')).rows;
}
export async function addHoliday(db: Db, actor: AuthUser, d: string, label: string) {
  await db.query('INSERT INTO holidays (d, label) VALUES ($1,$2) ON CONFLICT (d) DO UPDATE SET label = $2', [d, label]);
  await writeAudit(db, { actorId: actor.id, action: 'holiday.add', entityType: 'holidays', entityId: d, after: { label } });
}

// ── Company profile (singleton) ──
export async function getCompanyProfile(db: Db) {
  return (await db.query('SELECT * FROM company_profile WHERE id = 1')).rows[0] ?? null;
}
export async function updateCompanyProfile(db: Db, actor: AuthUser, p: Record<string, unknown>) {
  const fields = ['legal_name', 'former_legal_name', 'short_name', 'tan', 'tan_holder_name', 'tan_amendment_pending', 'signatory_name', 'signatory_designation'];
  await genericUpdate(db, actor, 'company_profile', 1, p, fields, 'company_profile.update', 'id');
}

// ── Bond certificate director signatures (one of 3 fixed slots) ──
const BOND_SIG_COL = (i: number) => `bond_signature_${i + 1}_path`;

export async function uploadBondSignature(db: Db, actor: AuthUser, index: number, filename: string, dataBase64: string) {
  if (index < 0 || index > 2) throw errors.badRequest('Signature slot must be 1, 2 or 3');
  const { validateUpload } = await import('../../lib/uploads.js');
  const { buffer, mime } = validateUpload(dataBase64);
  if (!mime.startsWith('image/')) throw errors.badRequest('Signature must be an image (JPEG, PNG or WebP)');
  const { saveBuffer, removeStored } = await import('../../lib/storage.js');
  const { path } = saveBuffer('bond-signatures', filename, buffer);
  const col = BOND_SIG_COL(index);
  const prev = (await db.query<Record<string, string | null>>(`SELECT ${col} FROM company_profile WHERE id = 1`)).rows[0];
  await db.query(`UPDATE company_profile SET ${col} = $1, updated_at = now() WHERE id = 1`, [path]);
  if (prev?.[col]) removeStored(prev[col]!);
  await writeAudit(db, { actorId: actor.id, action: 'company_profile.bond-signature.upload', entityType: 'company_profile', entityId: 1, after: { index, filename } });
  return { path };
}

export async function deleteBondSignature(db: Db, actor: AuthUser, index: number) {
  if (index < 0 || index > 2) throw errors.badRequest('Signature slot must be 1, 2 or 3');
  const { removeStored } = await import('../../lib/storage.js');
  const col = BOND_SIG_COL(index);
  const prev = (await db.query<Record<string, string | null>>(`SELECT ${col} FROM company_profile WHERE id = 1`)).rows[0];
  if (!prev?.[col]) return { ok: true };
  await db.query(`UPDATE company_profile SET ${col} = NULL, updated_at = now() WHERE id = 1`);
  removeStored(prev[col]!);
  await writeAudit(db, { actorId: actor.id, action: 'company_profile.bond-signature.delete', entityType: 'company_profile', entityId: 1, after: { index } });
  return { ok: true };
}

export async function getBondSignature(db: Db, index: number): Promise<{ buffer: Buffer; mime: string } | null> {
  if (index < 0 || index > 2) return null;
  const col = BOND_SIG_COL(index);
  const row = (await db.query<Record<string, string | null>>(`SELECT ${col} FROM company_profile WHERE id = 1`)).rows[0];
  const path = row?.[col];
  if (!path) return null;
  const { readStored } = await import('../../lib/storage.js');
  const buffer = readStored(path);
  if (!buffer) return null;
  const ext = path.split('.').pop()?.toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { buffer, mime };
}

// ── Acknowledgment authorised-signatory (CEO) signature — single slot ──
// The receipt acknowledgment PDF used to draw a hardcoded on-disk image that was
// never supplied; now the signature lives in the DB and is uploaded from Masters
// → Company profile, exactly like the bond director signatures above.
export async function uploadAckSignature(db: Db, actor: AuthUser, filename: string, dataBase64: string) {
  const { validateUpload } = await import('../../lib/uploads.js');
  const { buffer, mime } = validateUpload(dataBase64);
  if (!mime.startsWith('image/')) throw errors.badRequest('Signature must be an image (JPEG, PNG or WebP)');
  const { saveBuffer, removeStored } = await import('../../lib/storage.js');
  const { path } = saveBuffer('ack-signatures', filename, buffer);
  const prev = (await db.query<{ ack_signature_path: string | null }>('SELECT ack_signature_path FROM company_profile WHERE id = 1')).rows[0];
  await db.query('UPDATE company_profile SET ack_signature_path = $1, updated_at = now() WHERE id = 1', [path]);
  if (prev?.ack_signature_path) removeStored(prev.ack_signature_path);
  await writeAudit(db, { actorId: actor.id, action: 'company_profile.ack-signature.upload', entityType: 'company_profile', entityId: 1, after: { filename } });
  return { path };
}

export async function deleteAckSignature(db: Db, actor: AuthUser) {
  const { removeStored } = await import('../../lib/storage.js');
  const prev = (await db.query<{ ack_signature_path: string | null }>('SELECT ack_signature_path FROM company_profile WHERE id = 1')).rows[0];
  if (!prev?.ack_signature_path) return { ok: true };
  await db.query('UPDATE company_profile SET ack_signature_path = NULL, updated_at = now() WHERE id = 1');
  removeStored(prev.ack_signature_path);
  await writeAudit(db, { actorId: actor.id, action: 'company_profile.ack-signature.delete', entityType: 'company_profile', entityId: 1, after: {} });
  return { ok: true };
}

export async function getAckSignature(db: Db): Promise<{ buffer: Buffer; mime: string } | null> {
  const row = (await db.query<{ ack_signature_path: string | null }>('SELECT ack_signature_path FROM company_profile WHERE id = 1')).rows[0];
  const path = row?.ack_signature_path;
  if (!path) return null;
  const { readStored } = await import('../../lib/storage.js');
  const buffer = readStored(path);
  if (!buffer) return null;
  const ext = path.split('.').pop()?.toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { buffer, mime };
}

// ── helper ──
async function genericUpdate(
  db: Db, actor: AuthUser, table: string, id: number, input: Record<string, unknown>,
  allowed: string[], action: string, idCol = 'id'
) {
  await db.withTx(async (tx) => {
    const cur = await tx.query(`SELECT * FROM ${table} WHERE ${idCol} = $1`, [id]);
    if (!cur.rowCount) throw errors.notFound(`${table} not found`);
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    for (const f of allowed) {
      if (input[f] !== undefined) { sets.push(`${f} = $${++p}`); params.push(input[f]); }
    }
    if (!sets.length) return;
    params.push(id);
    await tx.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${idCol} = $${++p}`, params);
    await writeAudit(tx, { actorId: actor.id, action, entityType: table, entityId: id, before: cur.rows[0], after: input });
  });
}

// ── Locker pricing (NCD-owned deposit + rent per size; owner 2026-08-07) ──
export async function listLockerPricing(db: Db) {
  const rows = (await db.query<Record<string, unknown>>(
    'SELECT size, deposit_amount, annual_rent, updated_at FROM locker_pricing ORDER BY deposit_amount DESC NULLS LAST, size')).rows;
  return rows.map((r) => ({
    size: r.size,
    deposit_amount: r.deposit_amount == null ? null : Number(r.deposit_amount),
    annual_rent: r.annual_rent == null ? null : Number(r.annual_rent),
    updated_at: r.updated_at,
  }));
}

/** Create-or-update the deposit/rent for a size. A blank field clears to NULL. */
export async function upsertLockerPricing(db: Db, actor: AuthUser, size: string, input: { deposit_amount?: number | null; annual_rent?: number | null }) {
  const sz = String(size ?? '').trim();
  if (!sz) throw errors.badRequest('size is required');
  const num = (v: unknown): number | null => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw errors.badRequest('Amounts must be zero or more');
    return n;
  };
  const deposit = num(input.deposit_amount);
  const rent = num(input.annual_rent);
  await db.query(
    `INSERT INTO locker_pricing (size, deposit_amount, annual_rent, updated_by_user_id, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (size) DO UPDATE SET deposit_amount = EXCLUDED.deposit_amount, annual_rent = EXCLUDED.annual_rent,
       updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
    [sz, deposit, rent, actor.id]);
  await writeAudit(db, { actorId: actor.id, action: 'locker_pricing.upsert', entityType: 'locker_pricing', entityId: null, after: { size: sz, deposit_amount: deposit, annual_rent: rent } });
  return { size: sz, deposit_amount: deposit, annual_rent: rent };
}

/** The configured deposit/rent for a size — used to send NCD's own amounts to
 *  LockerHub on locker-application create. NULL when unset. */
export async function lockerPricingFor(db: Db, size: string): Promise<{ deposit_amount: number | null; annual_rent: number | null } | null> {
  const r = (await db.query<Record<string, unknown>>('SELECT deposit_amount, annual_rent FROM locker_pricing WHERE size = $1', [String(size ?? '').trim()])).rows[0];
  if (!r) return null;
  return {
    deposit_amount: r.deposit_amount == null ? null : Number(r.deposit_amount),
    annual_rent: r.annual_rent == null ? null : Number(r.annual_rent),
  };
}
