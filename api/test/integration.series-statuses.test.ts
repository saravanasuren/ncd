/**
 * A series has Open, Allotted and Closed — plus Withdrawn, which the owner
 * chose to keep (2026-08-20: "remove closing and keep withdrawn").
 *
 * 'Closing' was a staging state between Open and Allotted. Removing it is only
 * safe if nothing can still PUT a series there, and one thing could: reverting
 * an allotment set the series to 'Closing' explicitly. Left alone that would
 * have parked a live series in a status the machine no longer knows — the
 * revert would appear to work and leave the series unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { canTransition, STATUS_MACHINES } from '@new-wealth/shared';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('the series statuses', () => {
  // PendingApproval is the gate a NEW series sits behind (added 2026-08-19);
  // it is not a state anyone drives to, so the owner's "three statuses" are the
  // three a live series moves between — plus Withdrawn, which they kept.
  it('are exactly PendingApproval, Open, Allotted, Closed, Withdrawn — no Closing', async () => {
    expect(Object.keys(STATUS_MACHINES.series).sort())
      .toEqual(['Allotted', 'Closed', 'Open', 'PendingApproval', 'Withdrawn']);
  });

  it('no status can lead to Closing any more', async () => {
    for (const [from, def] of Object.entries(STATUS_MACHINES.series)) {
      expect((def as { next: string[] }).next, `${from} still offers Closing`).not.toContain('Closing');
    }
  });

  it('Open goes straight to Allotted', () => {
    expect(canTransition('series', 'Open', 'Allotted')).toBe(true);
    expect(canTransition('series', 'Open', 'Closing')).toBe(false);
  });

  it('Withdrawn is kept, and is still terminal', () => {
    expect(canTransition('series', 'Open', 'Withdrawn')).toBe(true);
    expect(canTransition('series', 'Allotted', 'Withdrawn')).toBe(true);
    expect((STATUS_MACHINES.series as any).Withdrawn.next).toEqual([]);
  });

  it('nothing in the database is left in Closing', async () => {
    const { rows } = await ctx.db.query("SELECT count(*)::int AS n FROM series WHERE status = 'Closing'");
    expect(Number((rows[0] as any).n)).toBe(0);
  });
});

describe('reverting an allotment', () => {
  it('reopens the series as Open, never the retired Closing', async () => {
    const c = new Client(ctx.base);
    await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });

    const seriesId = Number((await ctx.db.query(
      `INSERT INTO series (code, name, status) VALUES ('NCD REV','NCD Revert Case','Allotted') RETURNING id`)).rows[0]!.id);
    const cid = Number((await ctx.db.query(
      `INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active)
       VALUES ('REVC01','Revert Case','9744000001','Approved',TRUE) RETURNING id`)).rows[0]!.id);
    await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received, allotment_date)
       VALUES ('APP-REV-1',$1,$2,'Active',100000,'2026-07-01','2026-07-01')`, [cid, seriesId]);

    const r = await c.post(`/api/allotments/series/${seriesId}/revert`, { reason: 'test' });
    expect(r.status).toBe(200);

    const after = (await ctx.db.query<{ status: string }>(
      'SELECT status FROM series WHERE id = $1', [seriesId])).rows[0]!;
    expect(after.status).toBe('Open');
    expect(after.status).not.toBe('Closing');
    // …and the series is usable again: Open must still reach Allotted.
    expect(canTransition('series', after.status, 'Allotted')).toBe(true);
  });
});
