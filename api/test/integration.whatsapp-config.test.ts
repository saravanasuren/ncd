/**
 * WhatsApp template config is admin-editable in Settings (owner 2026-08-25):
 * a bad variable mapping is rejected on save, and a message type turned OFF is
 * not sent — it fails with a clear reason rather than reaching a customer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { enqueue, drainOnce } from '../src/modules/notifications/service.js';
import { whatsappSettingKey } from '@new-wealth/shared';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const statusOf = async (id: number) =>
  String((await ctx.db.query('SELECT status FROM notifications_queue WHERE id = $1', [id])).rows[0]!.status);

describe('saving a WhatsApp template config', () => {
  it('rejects a mapping that references an unknown field', async () => {
    const a = await admin();
    const bad = await a.put(`/api/settings/${whatsappSettingKey('interest_paid')}`,
      { value: { template_name: 'ncd_interest_final', enabled: true, variables: ['name', 'not_a_field'] } });
    expect(bad.status).toBe(400);
  });

  it('accepts a valid config', async () => {
    const a = await admin();
    const ok = await a.put(`/api/settings/${whatsappSettingKey('interest_paid')}`,
      { value: { template_name: 'ncd_interest_final', enabled: true, variables: ['name', 'amount'] } });
    expect(ok.status).toBe(200);
  });
});

describe('the on/off toggle gates the actual send', () => {
  it('sends an enabled type but not a disabled one', async () => {
    const a = await admin();
    // Default acknowledgement is ON → drains to Sent (stub provider in tests).
    const onId = await enqueue(ctx.db, { channel: 'whatsapp', template: 'acknowledgment', to: '9700000001', payload: { name: 'On' } });
    await drainOnce(ctx.db, 25);
    expect(await statusOf(onId)).toBe('Sent');

    // Turn it OFF, enqueue again → the send is refused, not delivered.
    expect((await a.put(`/api/settings/${whatsappSettingKey('acknowledgment')}`,
      { value: { template_name: 'ncd_akn', enabled: false, variables: ['name'] } })).status).toBe(200);
    const offId = await enqueue(ctx.db, { channel: 'whatsapp', template: 'acknowledgment', to: '9700000002', payload: { name: 'Off' } });
    await drainOnce(ctx.db, 25);
    expect(await statusOf(offId)).toBe('Failed');
    const err = String((await ctx.db.query('SELECT error FROM notifications_queue WHERE id = $1', [offId])).rows[0]!.error);
    expect(err).toMatch(/turned off in Settings/);
  });
});
