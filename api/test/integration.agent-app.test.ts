/**
 * Agent-app surface (NCD_INTEGRATION_CONTRACT.md B23/B24):
 *  - B24 GET /agents/active, POST /agents/propose (X-Integration-Key)
 *  - B23 /api/my/* + /api/investor-leads?mine=1 (X-Integration-Key + X-Acting-As-Agent)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let agentId: number;
const KEY = 'dev-integration-key';

async function integ(method: string, path: string, body?: unknown, actingAgent?: number) {
  const headers: Record<string, string> = { 'X-Integration-Key': KEY };
  if (body) headers['Content-Type'] = 'application/json';
  if (actingAgent != null) headers['X-Acting-As-Agent'] = String(actingAgent);
  const res = await fetch(ctx.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json: any = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

beforeAll(async () => {
  ctx = await startTestServer();
  const p = await integ('POST', '/api/integration/agents/propose', { full_name: 'App Agent', phone: '9700100200', email: 'appagent@example.com' });
  agentId = Number(p.json.agent_id);
});
afterAll(async () => { await ctx.close(); });

describe('B24 — staff add-agent', () => {
  it('propose creates a pending agent; a repeat is idempotent by name', async () => {
    const again = await integ('POST', '/api/integration/agents/propose', { full_name: 'App Agent' });
    expect(again.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect(Number(again.json.agent_id)).toBe(agentId);
  });

  it('active list respects the limit', async () => {
    // approve the proposed agent so it is active
    await ctx.db.query("UPDATE agents SET is_active = TRUE WHERE id = $1", [agentId]);
    const r = await integ('GET', '/api/integration/agents/active?limit=5');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.agents)).toBe(true);
    expect(r.json.agents.length).toBeLessThanOrEqual(5);
    expect(r.json.agents.some((a: any) => Number(a.id) === agentId)).toBe(true);
  });
});

describe('B23 — /api/my/* agent surface', () => {
  it('400 without the X-Acting-As-Agent header', async () => {
    const r = await integ('GET', '/api/my/profile');
    expect(r.status).toBe(400);
  });

  it('profile GET then PUT (self-service fields)', async () => {
    const g = await integ('GET', '/api/my/profile', undefined, agentId);
    expect(g.status).toBe(200);
    expect(g.json.profile.agent_code).toBeTruthy();
    expect(g.json.profile.full_name).toBe('App Agent');

    const p = await integ('PUT', '/api/my/profile', { bank_name: 'HDFC', account_number: '123456789', ifsc: 'HDFC0001234' }, agentId);
    expect(p.status).toBe(200);
    expect(p.json.profile.bank_name).toBe('HDFC');
    expect(p.json.profile.ifsc).toBe('HDFC0001234');
  });

  it('earnings summary + breakdown', async () => {
    const s = await integ('GET', '/api/my/earnings/summary', undefined, agentId);
    expect(s.status).toBe(200);
    expect(s.json).toHaveProperty('accrued');
    expect(s.json).toHaveProperty('paid');
    expect(s.json).toHaveProperty('balance');
    const b = await integ('GET', '/api/my/earnings/breakdown', undefined, agentId);
    expect(b.status).toBe(200);
    expect(Array.isArray(b.json.rows)).toBe(true);
  });

  it('customers list (empty for a fresh agent)', async () => {
    const r = await integ('GET', '/api/my/customers', undefined, agentId);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.customers)).toBe(true);
  });

  it('investor-leads?mine=1 returns the agent-scoped list', async () => {
    const r = await integ('GET', '/api/investor-leads?mine=1', undefined, agentId);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.leads)).toBe(true);
  });
});
