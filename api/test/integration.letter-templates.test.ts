/**
 * The redemption letters as configuration (owner 2026-11-21).
 *
 * The property that matters most is the dull one: WITH NOTHING CONFIGURED,
 * every letter must come out exactly as it did before this existed. The table
 * holds overrides, not the letters, so an empty table is today's behaviour and
 * a bad row degrades to it rather than to a blank page.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let admin: Client, staff: Client;

beforeAll(async () => {
  ctx = await startTestServer();
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  staff = new Client(ctx.base);
  await staff.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
});
afterAll(async () => { await ctx.close(); });

const list = async () => (await admin.get('/api/letter-templates')).json;
const resolve = async (d: string) => (await admin.get(`/api/letter-templates/resolve/${d}`)).json.template;
const reset = (slug: string) => admin.del(`/api/letter-templates/${slug}`);

describe('out of the box', () => {
  it('offers the four ranges, none of them customised', async () => {
    const { templates } = await list();
    expect(templates.map((t: any) => t.slug)).toEqual(
      ['kiara', 'dhanam-private', 'dhanam-limited', 'consent']);
    expect(templates.every((t: any) => t.customised === false)).toBe(true);
  });

  it('the four ranges tile the timeline with no gap and no overlap', async () => {
    const { templates, warnings } = await list();
    expect(warnings).toEqual([]);
    expect(templates.map((t: any) => [t.valid_from, t.valid_to])).toEqual([
      [null, '2025-08-17'],
      ['2025-08-18', '2026-09-28'],
      ['2026-09-29', '2026-10-31'],
      ['2026-11-01', null],
    ]);
  });

  it('resolves the dates the system used before this screen existed', async () => {
    expect((await resolve('2025-01-01')).legal_name).toBe('Kiara Microcredit Private Limited');
    expect((await resolve('2025-08-17')).legal_name).toBe('Kiara Microcredit Private Limited');
    expect((await resolve('2025-08-18')).legal_name).toBe('Dhanam Investment and Finance Private Limited');
    expect((await resolve('2026-09-28')).legal_name).toBe('Dhanam Investment and Finance Private Limited');
    expect((await resolve('2026-09-29')).legal_name).toBe('Dhanam Investment and Finance Limited');
    expect((await resolve('2026-10-31')).kind).toBe('request');
    expect((await resolve('2026-11-01')).kind).toBe('consent');
  });
});

describe('editing a letter', () => {
  it('moving a from-date moves which letter a date produces', async () => {
    const before = await resolve('2026-10-15');
    expect(before.kind).toBe('request');

    const r = await admin.put('/api/letter-templates/consent', { valid_from: '2026-10-01' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await resolve('2026-10-15')).kind).toBe('consent');

    await reset('consent');
    expect((await resolve('2026-10-15')).kind).toBe('request');
  });

  it('changing a company name changes what the letter is addressed to', async () => {
    await admin.put('/api/letter-templates/dhanam-limited', { legal_name: 'Renamed Finance Limited' });
    expect((await resolve('2026-10-01')).legal_name).toBe('Renamed Finance Limited');
    const { templates } = await list();
    expect(templates.find((t: any) => t.slug === 'dhanam-limited').customised).toBe(true);
    // ...and everything it did not touch is still the built-in value.
    expect((await resolve('2026-10-01')).off_address.length).toBeGreaterThan(0);

    await reset('dhanam-limited');
    expect((await resolve('2026-10-01')).legal_name).toBe('Dhanam Investment and Finance Limited');
  });

  it('refuses a range that ends before it starts', async () => {
    const r = await admin.put('/api/letter-templates/kiara',
      { valid_from: '2026-01-01', valid_to: '2025-01-01' });
    expect(r.status).toBe(400);
  });

  it('says so when ranges leave a gap or overlap, without refusing the save', async () => {
    const gap = await admin.put('/api/letter-templates/dhanam-limited', { valid_to: '2026-10-01' });
    expect(gap.status).toBe(200);
    expect(gap.json.warnings.join(' ')).toContain('No letter is configured between');
    await reset('dhanam-limited');

    const over = await admin.put('/api/letter-templates/consent', { valid_from: '2026-09-01' });
    expect(over.status).toBe(200);
    expect(over.json.warnings.join(' ')).toContain('both cover');
    await reset('consent');
    expect((await list()).warnings).toEqual([]);
  });

  it('a date no range covers falls back to the built-in letter, never to nothing', async () => {
    // Disabling every range is the worst a configuration can be.
    for (const slug of ['kiara', 'dhanam-private', 'dhanam-limited', 'consent']) {
      await admin.put(`/api/letter-templates/${slug}`, { enabled: false });
    }
    expect(await resolve('2026-10-01')).toBeNull();

    // ...and the bulk tool still produces a letter for that date.
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    const headers = ['Letter Date', 'Name of the NCD Holder', 'NCD Series', 'No. of Debentures',
      'Amount (in Rs.)', 'Bank Name', 'Account Holder Name', 'Account No.', 'IFSC Code'];
    ws.addRow(headers);
    ws.addRow([new Date(Date.UTC(2026, 9, 1)), 'Holder Fallback', '29', 10, 1000000,
      'State Bank of India', 'Holder Fallback', '30012345678', 'SBIN0000123']);
    const b64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const p = await admin.post('/api/bulk-redemption-letters/preview',
      { data_base64: b64, filename: 'f.xlsx' });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.rows[0].errors).toEqual([]);
    expect(p.json.rows[0].addressed_to).toContain('Dhanam');

    for (const slug of ['kiara', 'dhanam-private', 'dhanam-limited', 'consent']) await reset(slug);
  });
});

describe('who may change the letters', () => {
  it('turns away a user without settings rights', async () => {
    expect((await staff.get('/api/letter-templates')).status).toBe(403);
    expect((await staff.put('/api/letter-templates/kiara', { legal_name: 'Nope' })).status).toBe(403);
  });
});
