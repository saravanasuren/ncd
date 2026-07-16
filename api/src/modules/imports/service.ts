/**
 * Backdated importer (docs/00 §12). Creates a customer (if new) + an Active
 * application with a materialised schedule for a historically-allotted NCD,
 * marking past-due interest rows Paid. Idempotent on a deterministic dedup
 * key (re-running the same rows inserts nothing new).
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { nextCode } from '../../lib/sequences.js';
import { materializeForApplication } from '../schedule/materialize.js';

export interface ImportRow {
  full_name: string;
  pan?: string;
  phone?: string;
  district?: string;
  series_code: string;
  scheme_code: string;
  amount: number;
  allotment_date: string; // YYYY-MM-DD
}

export async function runBackdatedImport(db: Db, actor: AuthUser, rows: ImportRow[]) {
  let created = 0, skipped = 0, customersCreated = 0;
  for (const row of rows) {
    const dedupKey = `IMPORT-${(row.pan ?? row.phone ?? row.full_name).toUpperCase()}-${row.series_code}-${row.amount}-${row.allotment_date}`;
    await db.withTx(async (tx) => {
      const dupe = await tx.query('SELECT 1 FROM applications WHERE lockerhub_intent_no = $1', [dedupKey]);
      if (dupe.rowCount) { skipped++; return; }

      const series = (await tx.query<{ id: string; deemed_date: string | null }>('SELECT id, deemed_date FROM series WHERE code = $1', [row.series_code])).rows[0];
      const scheme = (await tx.query<Record<string, unknown>>('SELECT * FROM schemes WHERE code = $1', [row.scheme_code])).rows[0];
      if (!series || !scheme) throw errors.badRequest(`Unknown series/scheme for ${row.full_name}`);

      // Upsert customer (by PAN, else by phone).
      let customer: { id: string } | undefined;
      if (row.pan) customer = (await tx.query<{ id: string }>('SELECT id FROM customers WHERE pan = $1 LIMIT 1', [row.pan])).rows[0];
      if (!customer && row.phone) customer = (await tx.query<{ id: string }>('SELECT id FROM customers WHERE phone = $1 LIMIT 1', [row.phone])).rows[0];
      if (!customer) {
        const code = await nextCode(tx, 'customer', 'DHN{seq:6}');
        const { rows: cr } = await tx.query<{ id: string }>(
          `INSERT INTO customers (customer_code, full_name, pan, phone, district, kyc_status, creation_status, is_active, enrolled_by_user_id)
           VALUES ($1,$2,$3,$4,$5,'Verified','Approved',TRUE,$6) RETURNING id`,
          [code, row.full_name, row.pan ?? null, row.phone ?? null, row.district ?? null, actor.id]);
        customer = cr[0]!;
        customersCreated++;
      }

      const appNo = await nextCode(tx, 'application', 'APP-{yyyy}-{seq:6}');
      const { rows: ar } = await tx.query<{ id: string }>(
        `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, customer_was_new_at_creation, source, allotment_date, interest_start_date, lockerhub_intent_no, enrolled_by_user_id)
         VALUES ($1,$2,$3,'Active',$4,TRUE,'import',$5,$5,$6,$7) RETURNING id`,
        [appNo, customer.id, series.id, row.amount, row.allotment_date, dedupKey, actor.id]);
      const appId = Number(ar[0]!.id);
      await tx.query(
        `INSERT INTO application_lines (application_id, scheme_id, coupon_rate_pct, tenure_months, payout_frequency, day_count_convention, amount, outstanding_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'Active')`,
        [appId, scheme.id, scheme.coupon_rate_pct, scheme.tenure_months, scheme.payout_frequency, scheme.day_count_convention, row.amount]);
      await materializeForApplication(tx, appId);
      // Mark past-due interest rows Paid (historic).
      await tx.query("UPDATE disbursement_schedule SET status = 'Paid', paid_at = due_date WHERE application_id = $1 AND due_date < now()::date AND due_type IN ('Interest','BrokenInterest')", [appId]);
      created++;
    });
  }
  await writeAudit(db, { actorId: actor.id, action: 'import.backdated', entityType: 'applications', after: { created, skipped, customersCreated } });
  return { created, skipped, customers_created: customersCreated };
}
