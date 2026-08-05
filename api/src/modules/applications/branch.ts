/**
 * Which branch earns an investment (owner 2026-08-04).
 *
 * The person who BROUGHT it decides: staff are linked to a branch, so a
 * referrer who resolves to a staff user hands over their branch. Everything
 * else — agent-sourced, unmatched, or a staff member with no branch recorded —
 * counts under HO, which is where agent relationships sit.
 *
 * Stamped onto the application at creation and never recomputed, so a staff
 * transfer cannot silently rewrite last month's branch report.
 *
 * The matching rule is deliberately identical to `EFF_REF` in reports/book.ts —
 * effective referrer (application's text, else the customer's), matched on
 * users.code first and full_name second. Branch totals and Staff-wise totals
 * must never disagree about who brought an investment.
 */
import type { Db } from '../../db/types.js';

/** The HO fallback. Null only if no branch is coded 'HO' at all. */
async function headOfficeId(db: Db): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM branches WHERE upper(btrim(code)) = 'HO' ORDER BY id LIMIT 1");
  return rows[0] ? Number(rows[0].id) : null;
}

export async function branchForReferrer(db: Db, referredByText: string | null | undefined): Promise<number | null> {
  const ref = String(referredByText ?? '').trim();
  if (ref) {
    const { rows } = await db.query<{ branch_id: string }>(
      `SELECT u.branch_id
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.name <> 'customer' AND u.is_staff = TRUE AND u.branch_id IS NOT NULL
          AND (upper(btrim(u.code)) = upper($1) OR lower(btrim(u.full_name)) = lower($1))
        ORDER BY (upper(btrim(u.code)) = upper($1)) DESC
        LIMIT 1`, [ref]);
    if (rows[0]?.branch_id) return Number(rows[0].branch_id);
  }
  return headOfficeId(db);
}
