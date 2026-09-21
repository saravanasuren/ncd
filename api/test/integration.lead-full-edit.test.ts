/**
 * Editing a lead — all of it (owner 2026-09-21: "in leads when i click on edit
 * - i only get limited edits ... i need the full editing thing where i can edit
 * everything about the lead ... this should be reflected across every user").
 *
 * The API already took every field; the screen offered three. So what is pinned
 * here is what a FULL edit needs that a three-field one never did:
 *
 *   · a field can be CLEARED, not only changed — null empties it;
 *   · switching NCD ↔ locker clears the detail that no longer applies;
 *   · and scope. updateLead had no check, so any user with leads:update could
 *     rewrite any lead by id — harmless-ish at three fields, a phone-number
 *     rewrite at all of them. Everyone who can see leads can edit them (every
 *     such role holds leads:update), but only the leads they can see.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
};
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const row = async (id: number) => (await ctx.db.query<Record<string, unknown>>(
  'SELECT * FROM investor_leads WHERE id = $1', [id])).rows[0]!;

async function lead(c: Client, body: Record<string, unknown>): Promise<number> {
  const r = await c.post('/api/leads', body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return Number(r.json.id);
}

describe('full lead edit', () => {
  it('changes every field in one save', async () => {
    const staff = await as('staff@demo.local');
    const id = await lead(staff, { full_name: 'Edit Me', phone: '9811100001', lead_type: 'ncd', interested_scheme: '12% 24M' });

    const r = await staff.put(`/api/leads/${id}`, {
      full_name: 'Edited Name', phone: '9811100099', place: 'Gandhipuram', district: 'Coimbatore',
      category: 'Retired', source: 'Referral', referred_by_text: 'AG-DEMO',
      lead_type: 'ncd', interested_scheme: '13% 36M', locker_size: null,
      expected_amount: 750000, follow_up_date: '2026-10-05', status: 'Follow-up', notes: 'Wants monthly payout',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);

    const l = await row(id);
    expect(l.full_name).toBe('Edited Name');
    expect(l.phone).toBe('9811100099');
    expect(l.place).toBe('Gandhipuram');
    expect(l.district).toBe('Coimbatore');
    expect(l.category).toBe('Retired');
    expect(l.source).toBe('Referral');
    expect(l.referred_by_text).toBe('AG-DEMO');
    expect(l.interested_scheme).toBe('13% 36M');
    expect(Number(l.expected_amount)).toBe(750000);
    expect(String(l.follow_up_date).slice(0, 10)).toBe('2026-10-05');
    expect(l.status).toBe('Follow-up');
    expect(l.notes).toBe('Wants monthly payout');
  });

  it('CLEARS a field sent as null — or as a blank box', async () => {
    // The old edit could change a follow-up date but never take one off; and a
    // blank date was a database error.
    const staff = await as('staff@demo.local');
    const id = await lead(staff, {
      full_name: 'Clear Me', phone: '9811100002', place: 'Ukkadam', lead_type: 'ncd',
      expected_amount: 200000, follow_up_date: '2026-10-01', notes: 'x',
    });
    const r = await staff.put(`/api/leads/${id}`, {
      phone: null, place: '   ', expected_amount: null, follow_up_date: null, notes: '',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const l = await row(id);
    expect(l.phone).toBeNull();
    expect(l.place).toBeNull();          // a blank box is "nothing", not ''
    expect(l.expected_amount).toBeNull();
    expect(l.follow_up_date).toBeNull();
    expect(l.notes).toBeNull();
    expect(l.full_name).toBe('Clear Me'); // untouched fields stay as they were
  });

  it('switching NCD → locker drops the scheme, and back drops the size', async () => {
    const staff = await as('staff@demo.local');
    const id = await lead(staff, { full_name: 'Switch Me', lead_type: 'ncd', interested_scheme: '13% 36M' });

    await staff.put(`/api/leads/${id}`, { lead_type: 'locker', locker_size: 'XL' });
    let l = await row(id);
    expect(l.lead_type).toBe('locker');
    expect(l.locker_size).toBe('XL');
    expect(l.interested_scheme).toBeNull();

    await staff.put(`/api/leads/${id}`, { lead_type: 'ncd', interested_scheme: '12% 24M' });
    l = await row(id);
    expect(l.lead_type).toBe('ncd');
    expect(l.interested_scheme).toBe('12% 24M');
    expect(l.locker_size).toBeNull();
  });

  it('refuses to blank the name, and refuses a malformed date', async () => {
    const staff = await as('staff@demo.local');
    const id = await lead(staff, { full_name: 'Keep My Name' });
    expect((await staff.put(`/api/leads/${id}`, { full_name: '   ' })).status).toBe(400);
    expect((await staff.put(`/api/leads/${id}`, { follow_up_date: '05/10/2026' })).status).toBe(400);
    expect((await row(id)).full_name).toBe('Keep My Name');
  });

  it('still accepts the old three-field payload — a tab open across the deploy', async () => {
    const staff = await as('staff@demo.local');
    const id = await lead(staff, { full_name: 'Old Tab' });
    const r = await staff.put(`/api/leads/${id}`, { status: 'Follow-up', follow_up_date: '2026-10-09', expected_amount: 100000 });
    expect(r.status).toBe(200);
    expect((await row(id)).status).toBe('Follow-up');
  });

  it('works the same for every role that can see leads', async () => {
    // "reflected across every user" — each of these holds leads:update.
    for (const [who, pw] of [
      ['agent@demo.local', undefined], ['bm@demo.local', undefined], ['ncd@demo.local', undefined],
      ['admin@dhanam.finance', 'ChangeMe_Dev_123'],
    ] as const) {
      const c = await as(who, pw);
      const id = await lead(c, { full_name: `Role Edit ${who}` });
      const r = await c.put(`/api/leads/${id}`, { full_name: `Role Edited ${who}`, district: 'Salem' });
      expect(r.status, `${who}: ${JSON.stringify(r.json)}`).toBe(200);
      expect((await row(id)).district, who).toBe('Salem');
    }
  });

  it('CONTROL: nobody can edit a lead outside their own scope', async () => {
    const agent = await as('agent@demo.local');
    const agentsLead = await lead(agent, { full_name: 'Agent Owned', phone: '9811100077' });

    // A branch staff member cannot see it, so cannot change it — and learns
    // nothing about whether it exists.
    const staff = await as('staff@demo.local');
    const r = await staff.put(`/api/leads/${agentsLead}`, { phone: '9000000000', full_name: 'Hijacked' });
    expect(r.status).toBe(404);
    const l = await row(agentsLead);
    expect(l.phone).toBe('9811100077');
    expect(l.full_name).toBe('Agent Owned');

    // Someone who CAN see every lead can edit it.
    const a = await admin();
    expect((await a.put(`/api/leads/${agentsLead}`, { district: 'Erode' })).status).toBe(200);
    expect((await row(agentsLead)).district).toBe('Erode');
  });

  it('every edit is audited, with the before and after', async () => {
    const staff = await as('staff@demo.local');
    const id = await lead(staff, { full_name: 'Audit Me', phone: '9811100005' });
    await staff.put(`/api/leads/${id}`, { phone: '9811100006' });
    const a = (await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE action = 'lead.update' AND entity_id = $1", [String(id)])).rows[0]!;
    expect(Number(a.n)).toBe(1);
  });
});
