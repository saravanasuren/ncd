/** Products/masters service — schemes, series, TDS rules, banks, holidays,
 * company profile (docs/04 §2). All writes audited + status-machine guarded. */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { assertTransition } from '../../lib/statusMachine.js';

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
export async function createSeries(db: Db, actor: AuthUser, s: Record<string, unknown>) {
  return db.withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO series (code, name, status, face_value, deemed_date, opened_at)
       VALUES ($1,$2,'Open',$3,$4, now()) RETURNING id`,
      [s.code, s.name, s.face_value ?? null, s.deemed_date ?? null]
    );
    const id = Number(rows[0]!.id);
    // link schemes if provided
    if (Array.isArray(s.scheme_ids)) {
      for (const sid of s.scheme_ids as number[]) {
        await tx.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, sid]);
      }
    }
    await writeAudit(tx, { actorId: actor.id, action: 'series.create', entityType: 'series', entityId: id, after: s });
    return { id };
  });
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
