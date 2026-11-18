/**
 * Bulk Redemption Letters, end to end over HTTP.
 *
 * The thing worth guarding here is the promise the tool makes: it produces
 * documents and changes NOTHING. So alongside the happy path there is a test
 * that counts the redemption, application and customer rows either side of a
 * generate and insists they are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email, password });
  return c;
};

const HEADERS = [
  'Letter Date', 'Name of the NCD Holder', 'NCD Series', 'No. of Debentures',
  'Amount (in Rs.)', 'Bank Name', 'Account Holder Name', 'Account No.', 'IFSC Code', 'Customer Code',
];

async function sheetB64(rows: Record<string, unknown>[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? ''));
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

const GOOD = {
  'Letter Date': new Date(Date.UTC(2026, 9, 27)),
  'Name of the NCD Holder': 'Sundaramam K S',
  'NCD Series': '29',
  'No. of Debentures': 10,
  'Amount (in Rs.)': 1000000,
  'Bank Name': 'State Bank of India',
  'Account Holder Name': 'Sundaramam K S',
  'Account No.': '30012345678',
  'IFSC Code': 'SBIN0000123',
};
const KIARA_ERA = { ...GOOD, 'Letter Date': new Date(Date.UTC(2025, 6, 15)) };

/** POST something that comes back as bytes (the zip / a PDF). */
async function postRaw(c: Client, path: string, body: unknown) {
  const res = await fetch(ctx.base + path, {
    method: 'POST',
    headers: {
      'X-Requested-With': 'dhanam',
      'Content-Type': 'application/json',
      Cookie: c.cookieHeader(),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

describe('who can use it', () => {
  it('turns away anyone not signed in', async () => {
    const anon = new Client(ctx.base);
    expect((await anon.get('/api/bulk-redemption-letters/template.xlsx')).status).toBe(401);
    expect((await anon.post('/api/bulk-redemption-letters/preview', {})).status).toBe(401);
  });

  it('turns away a signed-in user without redemption rights', async () => {
    const staff = await as('staff@demo.local');
    expect((await staff.post('/api/bulk-redemption-letters/preview', {})).status).toBe(403);
  });

  it('lets the NCD manager in', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.raw('/api/bulk-redemption-letters/template.xlsx');
    expect(r.status).toBe(200);
  });
});

describe('the template', () => {
  it('is a workbook carrying every column', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.raw('/api/bulk-redemption-letters/template.xlsx');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('spreadsheetml');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    for (const h of HEADERS) expect(header).toContain(h);
    // And the notes tab, because a column name cannot explain a date format.
    expect(wb.worksheets.map((w) => w.name)).toContain('How to fill this in');
  });

  it('round-trips: the template we hand out parses cleanly once filled', async () => {
    const ncd = await as('ncd@demo.local');
    const t = await ncd.raw('/api/bulk-redemption-letters/template.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(t.buffer as unknown as ArrayBuffer);
    // The example row stands in for a filled-in one.
    const filled = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const r = await ncd.post('/api/bulk-redemption-letters/preview',
      { filename: 'filled.xlsx', data_base64: filled });
    expect(r.status).toBe(200);
    expect(r.json.header_errors).toEqual([]);
    expect(r.json.summary.ready).toBe(1);
  });
});

describe('preview', () => {
  it('reads the rows and says who each letter is addressed to', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.post('/api/bulk-redemption-letters/preview',
      { filename: 'x.xlsx', data_base64: await sheetB64([GOOD, KIARA_ERA]) });
    expect(r.status).toBe(200);
    expect(r.json.summary.total).toBe(2);
    expect(r.json.summary.ready).toBe(2);
    expect(r.json.rows[0].addressed_to).toBe('Dhanam Investment and Finance Limited');
    expect(r.json.rows[1].addressed_to).toBe('Kiara Microcredit Private Limited');
    const companies = r.json.summary.by_company.map((c: { company: string }) => c.company);
    expect(companies).toHaveLength(2);
  });

  it('names the row and the problem when something is wrong', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.post('/api/bulk-redemption-letters/preview',
      { filename: 'x.xlsx', data_base64: await sheetB64([GOOD, { ...GOOD, 'IFSC Code': '' }]) });
    expect(r.json.summary.with_errors).toBe(1);
    const bad = r.json.rows.find((x: { errors: string[] }) => x.errors.length);
    expect(bad.row_no).toBe(3);
    expect(bad.errors.join(' ')).toContain('IFSC Code');
  });

  it('says which columns are missing rather than guessing', async () => {
    const ncd = await as('ncd@demo.local');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S').addRow(['Letter Date', 'Name of the NCD Holder']);
    const b64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const r = await ncd.post('/api/bulk-redemption-letters/preview', { filename: 'x.xlsx', data_base64: b64 });
    expect(r.status).toBe(200);
    expect(r.json.header_errors.join(' ')).toContain('NCD Series');
  });

  it('cautions when a given customer code is not in the book, and still prints', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.post('/api/bulk-redemption-letters/preview',
      { filename: 'x.xlsx', data_base64: await sheetB64([{ ...GOOD, 'Customer Code': 'DHN999999' }]) });
    expect(r.json.rows[0].errors).toEqual([]);
    expect(r.json.rows[0].cautions.join(' ')).toMatch(/DHN999999/);
  });
});

describe('generate', () => {
  it('returns a zip and reports how many letters are in it', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await postRaw(ncd, '/api/bulk-redemption-letters/generate',
      { filename: 'x.xlsx', data_base64: await sheetB64([GOOD, KIARA_ERA]) });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('zip');
    expect(r.headers.get('x-letters-generated')).toBe('2');
    expect(r.headers.get('x-letters-failed')).toBe('0');
    expect(r.buffer.readUInt32LE(0)).toBe(0x04034b50);
    expect(r.buffer.subarray(r.buffer.length - 22).readUInt16LE(8)).toBe(2);
    // The holder's name reaches the filenames inside.
    expect(r.buffer.toString('latin1')).toContain('Sundaramam K S');
  });

  it('skips the rows that need fixing and still produces the rest', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await postRaw(ncd, '/api/bulk-redemption-letters/generate',
      { filename: 'x.xlsx', data_base64: await sheetB64([GOOD, { ...GOOD, 'Account No.': '' }]) });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-letters-generated')).toBe('1');
    expect(r.headers.get('x-letters-failed')).toBe('1');
  });

  it('refuses rather than returning an empty archive when nothing is usable', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.post('/api/bulk-redemption-letters/generate',
      { filename: 'x.xlsx', data_base64: await sheetB64([{ ...GOOD, 'IFSC Code': '', 'Account No.': '' }]) });
    expect(r.status).toBe(400);
  });

  it('CHANGES NOTHING — the book is identical either side of a generate', async () => {
    const ncd = await as('ncd@demo.local');
    const counts = async () => {
      const q = async (t: string) =>
        Number((await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n);
      return {
        redemptions: await q('redemptions'),
        applications: await q('applications'),
        customers: await q('customers'),
        approvals: await q('approval_requests'),
        audit: await q('audit_log'),
      };
    };
    const before = await counts();
    const r = await postRaw(ncd, '/api/bulk-redemption-letters/generate',
      { filename: 'x.xlsx', data_base64: await sheetB64([GOOD, KIARA_ERA]) });
    expect(r.status).toBe(200);
    expect(await counts()).toEqual(before);
  });
});

describe('a single letter', () => {
  it('comes back as a PDF named after the holder and the date', async () => {
    const ncd = await as('ncd@demo.local');
    const body = { filename: 'x.xlsx', data_base64: await sheetB64([GOOD]), row_no: 2 };
    const r = await postRaw(ncd, '/api/bulk-redemption-letters/letter', body);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('pdf');
    expect(r.headers.get('content-disposition')).toContain('Sundaramam K S - 27-Oct-2026.pdf');
    expect(r.buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses a row that has errors instead of printing a half-filled letter', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.post('/api/bulk-redemption-letters/letter',
      { filename: 'x.xlsx', data_base64: await sheetB64([{ ...GOOD, 'IFSC Code': '' }]), row_no: 2 });
    expect(r.status).toBe(400);
  });

  it('404s on a row that is not in the file', async () => {
    const ncd = await as('ncd@demo.local');
    const r = await ncd.post('/api/bulk-redemption-letters/letter',
      { filename: 'x.xlsx', data_base64: await sheetB64([GOOD]), row_no: 99 });
    expect(r.status).toBe(404);
  });
});

describe('the configurable boundary', () => {
  it('moving the setting moves which company the letters name', async () => {
    const ncd = await as('ncd@demo.local');
    const body = { filename: 'x.xlsx', data_base64: await sheetB64([KIARA_ERA]) };

    const before = await ncd.post('/api/bulk-redemption-letters/preview', body);
    expect(before.json.rows[0].addressed_to).toBe('Kiara Microcredit Private Limited');

    // Move the boundary back so the same date now falls on the Dhanam side.
    await ctx.db.query(
      `INSERT INTO app_settings (key, value, group_name, label)
       VALUES ('redemption.letter_dhanam_from', '"2025-01-01"'::jsonb, 'Redemptions', 'x')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

    const after = await ncd.post('/api/bulk-redemption-letters/preview', body);
    expect(after.json.rows[0].addressed_to).toBe('Dhanam Investment and Finance Private Limited');

    await ctx.db.query(
      `UPDATE app_settings SET value = '"2025-08-18"'::jsonb WHERE key = 'redemption.letter_dhanam_from'`);
  });
});
