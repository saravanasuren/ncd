/** Test harness: PGlite-backed API on an ephemeral port + a cookie-aware client. */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PgliteDb } from '../../src/db/pglite.js';
import { setDb } from '../../src/db/index.js';
import { seed } from '../../src/db/seed.js';
import { createApp } from '../../src/app.js';

export interface TestCtx {
  base: string;
  server: Server;
  db: PgliteDb;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestCtx> {
  const db = new PgliteDb();
  await seed(db);
  setDb(db);
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    db,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db.close();
    },
  };
}

/**
 * Take a just-created application live via the investment approval (the new
 * one-gate go-live). `create` is the POST /api/applications response; `checker`
 * must be a DISTINCT user from the app's maker (maker ≠ checker rule). Returns
 * the approval response so callers can assert on it.
 */
export async function approveInvestment(checker: Client, create: { json: { subscription_request?: { id: number } } }) {
  const reqId = create.json.subscription_request?.id;
  if (!reqId) throw new Error('create response had no subscription_request to approve');
  return checker.post(`/api/approvals/${reqId}/approve`);
}

/** Minimal cookie jar over fetch. Sends X-Requested-With for CSRF. */
export class Client {
  private cookies: Record<string, string> = {};
  constructor(private base: string) {}

  async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { 'X-Requested-With': 'dhanam' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const val = pair!.slice(eq + 1);
      if (val === '') delete this.cookies[name];
      else this.cookies[name] = val;
    }
    let json: any = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  }
  get(p: string) { return this.req('GET', p); }
  post(p: string, b?: unknown) { return this.req('POST', p, b ?? {}); }
  put(p: string, b?: unknown) { return this.req('PUT', p, b ?? {}); }
  del(p: string, b?: unknown) { return this.req('DELETE', p, b); }

  /** Fetch raw bytes (for binary downloads like xlsx). */
  async raw(path: string): Promise<{ status: number; buffer: Buffer; headers: Headers }> {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(this.base + path, { headers: cookie ? { Cookie: cookie } : {} });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buffer, headers: res.headers };
  }
}
