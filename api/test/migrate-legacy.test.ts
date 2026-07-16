/**
 * Phase 8 — legacy migration ETL proof (synthetic source, PGlite target).
 * Verifies the transform/load + the owner's interest freeze/recompute rule
 * end-to-end, with ZERO real data. The real dry-run runs the identical pipeline
 * against a local restore of the prod dump (docs/09).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PgliteDb } from '../src/db/pglite.js';
import { migrate } from '../src/db/migrate.js';
import { ROLES, ROLE_LABELS, ROLE_LEVEL } from '@new-wealth/shared';
import { runMigration } from '../src/migrate-legacy/pipeline.js';
import { SyntheticLegacySource } from '../src/migrate-legacy/synthetic.js';
import { INTEREST_ANCHOR } from '../src/migrate-legacy/config.js';

// Same id convention the seed uses (index+1) so role ids are stable.
const ROLE_IDS: Record<string, number> = Object.fromEntries(ROLES.map((r, i) => [r, i + 1]));

let db: PgliteDb;

// Minimal clean target: schema + the 8 roles (no demo book, so counts are exact).
beforeEach(async () => {
  db = new PgliteDb();
  await migrate(db);
  for (const role of ROLES) {
    await db.query('INSERT INTO roles (id, name, label, level) VALUES ($1,$2,$3,$4)', [
      ROLE_IDS[role], role, ROLE_LABELS[role], ROLE_LEVEL[role],
    ]);
  }
});
afterEach(async () => { await db.close(); });

describe('legacy migration — dry-run reconciliation', () => {
  it('loads the whole book, preserves paid interest, recomputes future from the anchor', async () => {
    const report = await runMigration(new SyntheticLegacySource(), db, { dryRun: true });

    // ── table counts ──────────────────────────────────────────────────
    const stat = (t: string) => report.tables.find((x) => x.table === t)!;
    expect(stat('customers').loaded).toBe(3);
    expect(stat('customers').failed).toBe(0);
    expect(stat('applications').loaded).toBe(3);
    expect(stat('application_lines').loaded).toBe(3);
    expect(stat('customer_bank_accounts').loaded).toBe(3);
    expect(stat('agents').loaded).toBe(1);
    expect(stat('series').loaded).toBe(1);
    expect(stat('schemes').loaded).toBe(1);
    expect(stat('redemptions').loaded).toBe(1);
    // every table load should be clean
    for (const t of report.tables) expect(t.failed, `${t.table} had failures`).toBe(0);

    // ── AUM parity: active principal in == out ────────────────────────
    expect(report.aum.activeSource).toBe(1200000); // App1 1,000,000 + App3 200,000
    expect(report.aum.activeLoaded).toBe(1200000);

    // ── interest freeze: every PAID source row is preserved ───────────
    expect(report.interest.oldPaidRows).toBe(report.interest.loadedPaidRows);
    expect(report.interest.oldPaidRows).toBe(5); // line1:2 + line2:2 + line3:1
    expect(report.interest.regeneratedRows).toBeGreaterThan(0);

    // ── the sample proves Jun-29 → Jul-28 = 30 days ───────────────────
    expect(report.sample).toBeDefined();
    const first = report.sample!.newFuture[0]!;
    expect(first.due_date).toBe('2026-07-28');
    expect(first.due_type).toBe('Interest');
    expect(first.period_days).toBe(30);
    // App1 line = ₹10,00,000 @ 12% for 30/365 days = 9863.01
    expect(first.gross).toBeCloseTo(9863.01, 2);

    // the old future rows (Jul-28 interest + maturity Redemption) were dropped
    expect(report.sample!.oldFuture.length).toBe(2);

    expect(report.anomalies).toEqual([]);
    expect(report.anchor).toBe(INTEREST_ANCHOR);
  });

  it('dry-run persists NOTHING (transaction rolled back)', async () => {
    await runMigration(new SyntheticLegacySource(), db, { dryRun: true });
    const c = await db.query('SELECT COUNT(*)::int AS n FROM customers');
    expect((c.rows[0] as any).n).toBe(0);
    const a = await db.query('SELECT COUNT(*)::int AS n FROM applications');
    expect((a.rows[0] as any).n).toBe(0);
  });

  it('commit mode persists the book', async () => {
    const report = await runMigration(new SyntheticLegacySource(), db, { dryRun: false });
    expect(report.dryRun).toBe(false);
    const c = await db.query('SELECT COUNT(*)::int AS n FROM customers');
    expect((c.rows[0] as any).n).toBe(3);
    // frozen paid rows + regenerated future rows both present
    const paid = await db.query("SELECT COUNT(*)::int AS n FROM disbursement_schedule WHERE status='Paid'");
    expect((paid.rows[0] as any).n).toBe(5);
    const sched = await db.query("SELECT COUNT(*)::int AS n FROM disbursement_schedule WHERE status='Scheduled' AND due_date > $1", [INTEREST_ANCHOR]);
    expect((sched.rows[0] as any).n).toBeGreaterThan(0);
    // no future scheduled row on/before the anchor survived
    const leak = await db.query("SELECT COUNT(*)::int AS n FROM disbursement_schedule WHERE status='Scheduled' AND due_date <= $1", [INTEREST_ANCHOR]);
    expect((leak.rows[0] as any).n).toBe(0);

    // id sequences advanced past migrated ids: a new customer gets max+1, no collision
    const before = await db.query('SELECT COALESCE(MAX(id),0)::int AS m FROM customers');
    const maxBefore = Number((before.rows[0] as any).m);
    const ins = await db.query("INSERT INTO customers (customer_code, full_name) VALUES ('DHNNEW','New After Migration') RETURNING id");
    expect(Number((ins.rows[0] as any).id)).toBeGreaterThan(maxBefore);
  });

  it('one bad row (duplicate PAN) does NOT cascade — it fails alone, rest load', async () => {
    // A source where customer #2 duplicates customer #1's PAN. In Postgres a
    // failed insert poisons the whole transaction unless each is savepointed;
    // this proves the savepoint guard: only the dup fails, everything else lands.
    class DupPanSource extends SyntheticLegacySource {
      async customers() {
        const rows = await super.customers();
        rows[1]!.pan = rows[0]!.pan; // Bravo now collides with Alpha's PAN
        return rows;
      }
    }
    const report = await runMigration(new DupPanSource(), db, { dryRun: true });
    const custStat = report.tables.find((t) => t.table === 'customers')!;
    expect(custStat.loaded).toBe(2);           // Alpha + Charlie
    expect(custStat.failed).toBe(1);           // Bravo (dup PAN) — isolated
    expect(report.anomalies.some((a) => a.includes('customers'))).toBe(true);
    // downstream did NOT cascade: applications for the surviving customers still load
    const appStat = report.tables.find((t) => t.table === 'applications')!;
    expect(appStat.loaded).toBeGreaterThanOrEqual(2);
    // AUM still reconciles for what loaded
    expect(report.aum.activeLoaded).toBeGreaterThan(0);
  });

  it('drops users with a DROP_ROLES role and nulls their enrolled-by links', async () => {
    // Reassign BE user #2 to an 'enroller' role (which is dropped). Customers/apps
    // enrolled by #2 must still migrate, with enrolled_by_user_id set NULL.
    class DropRoleSource extends SyntheticLegacySource {
      async roles() {
        const r = await super.roles();
        return [...r, { id: 9, name: 'enroller' }];
      }
      async users() {
        const u = await super.users();
        u[1]!.role_id = 9; // BE Test → enroller (dropped)
        return u;
      }
    }
    const report = await runMigration(new DropRoleSource(), db, { dryRun: false });
    // user #2 not migrated
    const u = await db.query('SELECT COUNT(*)::int AS n FROM users WHERE id = 2');
    expect((u.rows[0] as any).n).toBe(0);
    // customers enrolled by #2 still migrated, but unassigned
    const c = await db.query('SELECT COUNT(*)::int AS n FROM customers');
    expect((c.rows[0] as any).n).toBe(3);
    const linked = await db.query('SELECT COUNT(*)::int AS n FROM customers WHERE enrolled_by_user_id = 2');
    expect((linked.rows[0] as any).n).toBe(0);
    // reported as a note, and the role shows as dropped
    expect(report.notes.some((n) => n.includes('Dropped'))).toBe(true);
    expect(report.roleMapping.find((m) => m.oldRole === 'enroller')?.newRole).toContain('dropped');
  });
});
