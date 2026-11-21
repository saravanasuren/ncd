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

// ── The Consent letter in bulk (owner 2026-11-21) ───────────────────────────
//
// A row dated on or after 13 November 2026 produces the Consent for Premature
// Redemption — the same document the live redemption screen makes — INSTEAD OF
// the Request letter. Earlier rows are untouched, which is why every test
// above still passes unchanged: all of them predate the cut-off.
//
// The six consent columns are optional. What the sheet says wins; what it
// leaves empty is looked up from the customer's own record; what neither
// supplies prints blank and is named in the preview.

const CONSENT_HEADERS = [
  ...HEADERS,
  'Mode of Holding', 'Date of Allotment', 'Original Maturity Date', 'Coupon Rate', 'Face Value', 'PAN',
];

async function consentSheetB64(rows: Record<string, unknown>[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.addRow(CONSENT_HEADERS);
  for (const r of rows) ws.addRow(CONSENT_HEADERS.map((h) => r[h] ?? ''));
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

/** On or after the cut-off. */
const AFTER = { ...GOOD, 'Letter Date': new Date(Date.UTC(2026, 10, 20)) };

const previewOf = async (c: Client, b64: string, name = 'c.xlsx') =>
  (await c.post('/api/bulk-redemption-letters/preview', { data_base64: b64, filename: name })).json;

describe('bulk letters after the consent cut-off', () => {
  it('a row on or after 13 Nov 2026 makes the Consent letter, an earlier one does not', async () => {
    const c = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const p = await previewOf(c, await consentSheetB64([
      { ...AFTER, 'Name of the NCD Holder': 'Holder After' },
      { ...GOOD, 'Name of the NCD Holder': 'Holder Before' },
      { ...KIARA_ERA, 'Name of the NCD Holder': 'Holder Kiara' },
    ]));
    const kinds = p.rows.map((r: any) => [r.holder_name, r.letter_kind]);
    expect(kinds).toEqual([
      ['Holder After', 'consent'],
      ['Holder Before', 'request'],
      ['Holder Kiara', 'request'],
    ]);
  });

  it('the boundary day belongs to the consent letter', async () => {
    const c = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const p = await previewOf(c, await consentSheetB64([
      { ...GOOD, 'Letter Date': new Date(Date.UTC(2026, 10, 12)), 'Name of the NCD Holder': 'Holder Twelfth' },
      { ...GOOD, 'Letter Date': new Date(Date.UTC(2026, 10, 13)), 'Name of the NCD Holder': 'Holder Thirteenth' },
    ]));
    expect(p.rows.map((r: any) => r.letter_kind)).toEqual(['request', 'consent']);
  });

  it('generates a real Consent PDF for the post-cut-off row', async () => {
    const c = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const b64 = await consentSheetB64([{ ...AFTER, 'Mode of Holding': 'Demat', 'PAN': 'ABCDE1234F' }]);
    const one = await postRaw(c, '/api/bulk-redemption-letters/letter', { data_base64: b64, filename: 'c.xlsx', row_no: 2 });
    expect(one.status).toBe(200);
    expect(one.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    const { extractText } = await import('./helpers/pdf-text.js');
    const t = extractText(one.buffer).replace(/\s+/g, '');
    expect(t).toContain('ConsentforPrematureRedemption');
    expect(t).toContain('Waiverof2%additionalpremium.');
    expect(t).toContain('Demat');
    expect(t).toContain('ABCDE1234F');
    // ...and NOT the request letter's opening.
    expect(t).not.toContain('TheBoardofDirectors,');
  });

  it('takes Demat / Physical from the sheet, and cautions on anything else', async () => {
    const c = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const p = await previewOf(c, await consentSheetB64([
      { ...AFTER, 'Name of the NCD Holder': 'Holder D', 'Mode of Holding': 'demat' },
      { ...AFTER, 'Name of the NCD Holder': 'Holder P', 'Mode of Holding': 'PHYSICAL' },
      { ...AFTER, 'Name of the NCD Holder': 'Holder X', 'Mode of Holding': 'dunno' },
    ]));
    expect(p.rows[0].mode_of_holding).toBe('Demat');
    expect(p.rows[1].mode_of_holding).toBe('Physical');
    expect(p.rows[2].mode_of_holding).toBe('');
    expect(p.rows[2].cautions.join(' ')).toContain('not Demat or Physical');
    // An unreadable one is a caution, never an error — the letter still prints.
    expect(p.rows[2].errors).toEqual([]);
  });

  it('names the particulars that will print blank, before anything is generated', async () => {
    const c = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const p = await previewOf(c, await consentSheetB64([{ ...AFTER }]));
    const row = p.rows[0];
    expect(row.letter_kind).toBe('consent');
    // Nothing typed and no customer code to look anything up by.
    expect(row.blank_particulars).toContain('Mode of Holding');
    expect(row.blank_particulars).toContain('Date of Allotment');
    expect(row.blank_particulars).toContain('PAN');
    expect(row.cautions.join(' ')).toContain('will print these blank');
    // Still generable — a blank particular is written in by hand.
    expect(row.errors).toEqual([]);
  });

  it('what the sheet says wins over what the record says', async () => {
    const c = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const p = await previewOf(c, await consentSheetB64([{
      ...AFTER,
      'Date of Allotment': new Date(Date.UTC(2021, 0, 15)),
      'Coupon Rate': '13.5%',
      'Face Value': 100000,
      'PAN': 'ZZZZZ9999Z',
    }]));
    const row = p.rows[0];
    expect(row.allotment_date).toBe('2021-01-15');
    expect(row.coupon_rate_pct).toBe(13.5);
    expect(row.face_value).toBe(100000);
    expect(row.pan).toBe('ZZZZZ9999Z');
    expect(row.blank_particulars).not.toContain('PAN');
  });

  it('fills the gaps from the customer record when the sheet leaves them empty', async () => {
    const c = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    // A customer with a real investment to look up.
    const cust = await c.post('/api/customers', { full_name: 'Lookup Holder', phone: '9790000001', pan: 'LOOKU1234P' });
    const cid = Number(cust.json.id);
    const code = (await c.get(`/api/customers/${cid}`)).json.customer.customer_code;
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const seriesName = String((await ctx.db.query("SELECT name FROM series WHERE code = 'NCD DEMO'")).rows[0]!.name);
    await ctx.db.query('UPDATE series SET face_value = 250000 WHERE id = $1', [seriesId]);
    await ctx.db.query(
      `UPDATE applications SET allotment_date = DATE '2024-03-30', maturity_date = DATE '2029-03-30'
        WHERE id = (SELECT id FROM applications WHERE customer_id = $1 ORDER BY id LIMIT 1)`, [cid]);

    const appId = (await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount,
                                 allotment_date, maturity_date)
       VALUES ('APP-LOOKUP-1', $1, $2, 'Active', 500000, DATE '2024-03-30', DATE '2029-03-30') RETURNING id`,
      [cid, seriesId])).rows[0] as any;
    await ctx.db.query(
      `INSERT INTO application_lines (application_id, coupon_rate_pct, tenure_months, amount, outstanding_amount)
       VALUES ($1, 12.5, 60, 500000, 500000)`, [Number(appId.id)]);

    const p = await previewOf(c, await consentSheetB64([{
      ...AFTER, 'Name of the NCD Holder': 'Lookup Holder',
      'NCD Series': seriesName, 'Customer Code': code,
    }]));
    const row = p.rows[0];
    expect(row.allotment_date).toBe('2024-03-30');
    expect(row.original_maturity_date).toBe('2029-03-30');
    expect(row.coupon_rate_pct).toBe(12.5);
    expect(row.face_value).toBe(250000);
    expect(row.pan).toBe('LOOKU1234P');
    // Only the one a person must answer is left.
    expect(row.blank_particulars).toEqual(['Mode of Holding']);
  });

  it('a mixed file produces both kinds in one zip, and still changes nothing', async () => {
    const c = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const before = (await ctx.db.query(
      'SELECT (SELECT count(*) FROM redemptions) r, (SELECT count(*) FROM applications) a')).rows[0] as any;
    const zip = await postRaw(c, '/api/bulk-redemption-letters/generate', {
      data_base64: await consentSheetB64([
        { ...AFTER, 'Name of the NCD Holder': 'Mixed After', 'Mode of Holding': 'Demat' },
        { ...GOOD, 'Name of the NCD Holder': 'Mixed Before' },
      ]),
      filename: 'mixed.xlsx',
    });
    expect(zip.status).toBe(200);
    expect(zip.buffer.subarray(0, 2).toString()).toBe('PK');
    const after = (await ctx.db.query(
      'SELECT (SELECT count(*) FROM redemptions) r, (SELECT count(*) FROM applications) a')).rows[0] as any;
    expect(after).toEqual(before);
  });
});
