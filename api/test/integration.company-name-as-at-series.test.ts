/**
 * A bond names the company as it was when its SERIES was allotted.
 *
 * Owner 2026-11-03: "company became limited on 29th sep. so sd3 was closed on
 * 30 sep which is all investment in sd3 was alloted and closed on that date
 * only - so they all will be in limited." SD1 closed 31 July and SD2 closed
 * 31 August, both while it was still a PRIVATE limited company, so their
 * holders' bonds must say so — with the PTC form of the CIN.
 *
 * Scoped to the SUBORDINATE certificate. The Debenture Certificate that NCD 27,
 * NCD 28 and the twenty-odd older series print is left exactly as it is
 * ("dont ever touch ncd 27 or 28"), and the last test here holds that line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inflateSync } from 'node:zlib';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import { companyAsAt, COMPANY_RENAMED_ON } from '../src/modules/reports/forms/shared.js';

let ctx: TestCtx;
let schemeId: number, plainSeriesId: number;
const sd: Record<string, number> = {};
let admin: Client, checker: Client;

const OLD_NAME = 'Dhanam Investment and Finance Private Limited';
const OLD_CIN = 'U64920TZ2016PTC031308';
const NEW_CIN = 'U64920TZ2016PLC031308';

beforeAll(async () => {
  ctx = await startTestServer();
  plainSeriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  await ctx.db.query('UPDATE schemes SET tenure_months = 60 WHERE id = $1', [schemeId]);
  // The real close dates: SD2 the day before the change but one, SD3 the day after.
  for (const [code, close] of [['SD1', '2026-07-31'], ['SD2', '2026-08-31'], ['SD3', '2026-09-30']] as const) {
    sd[code] = Number((await ctx.db.query(
      `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
       VALUES ($1, $2, 'Closed', 100000, TRUE, $3::date, $3::date) RETURNING id`,
      [code, `Subordinate Debt ${code.slice(2)}`, close])).rows[0]!.id);
    await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1, $2)', [sd[code], schemeId]);
  }
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
});
afterAll(async () => { await ctx.close(); });

function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body: string;
    try { body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'); } catch { continue; }
    if (!body.includes('BT')) continue;
    for (const t of body.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const hex = t[1]!.replace(/\s+/g, '');
      if (hex.length % 2) continue;
      out.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    for (const t of body.matchAll(/\((?:\\.|[^\\()])*\)/g)) out.push(t[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
  }
  return out.join('');
}
const squash = (s: string) => s.replace(/\s+/g, '');

async function bondTextFor(seriesId: number, name: string, phone: string, received: string): Promise<string> {
  const cust = await admin.post('/api/customers', { full_name: name, phone });
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id,
    series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: received,
  });
  await approveInvestment(checker, app);
  const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
  return squash(pdfText(await consolidatedBondCertificatePdf(ctx.db, Number(cust.json.id), seriesId)));
}

describe('the bond names the company as at its series date', () => {
  it('SD1 (closed 31 July) says Private Limited, with the PTC CIN', async () => {
    const text = await bondTextFor(sd.SD1!, 'July Holder', '9552990001', '2026-07-29');
    expect(text).toContain(squash(OLD_NAME.toUpperCase()));
    expect(text).toContain(squash(OLD_CIN));
    expect(text).not.toContain(squash(NEW_CIN));
    // The promise-to-pay paragraph names the company too — both must agree, or
    // the certificate contradicts itself.
    expect(text).toContain(squash(`For Value Received, ${OLD_NAME}`));
  });

  it('SD2 (closed 31 August) says Private Limited too', async () => {
    const text = await bondTextFor(sd.SD2!, 'August Holder', '9552990002', '2026-08-15');
    expect(text).toContain(squash(OLD_CIN));
    expect(text).not.toContain(squash(NEW_CIN));
  });

  it('SD3 (closed 30 September, the day after the change) says Limited', async () => {
    const text = await bondTextFor(sd.SD3!, 'September Holder', '9552990003', '2026-09-15');
    expect(text).toContain(squash(NEW_CIN));
    expect(text).not.toContain(squash(OLD_CIN));
    expect(text).not.toContain(squash('PRIVATE LIMITED'));
  });

  it('turns exactly on 29 September, not a day either side', async () => {
    const co = { legal_name: 'Dhanam Investment and Finance Limited', cin: NEW_CIN };
    expect(COMPANY_RENAMED_ON).toBe('2026-09-29');
    expect(companyAsAt(co, '2026-09-28').cin).toBe(OLD_CIN);  // day before: old
    expect(companyAsAt(co, '2026-09-29').cin).toBe(NEW_CIN);  // the day itself: new
    expect(companyAsAt(co, '2026-09-30').cin).toBe(NEW_CIN);
    // No date at all keeps today's name — printing a superseded one on a
    // current bond would be the worse error.
    expect(companyAsAt(co, null).cin).toBe(NEW_CIN);
  });

  it('does NOT touch the Debenture Certificate the older series print', async () => {
    // The owner was explicit: "dont ever touch ncd 27 or 28". A non-subordinate
    // series keeps whatever the company profile says, whatever its date.
    const text = await bondTextFor(plainSeriesId, 'Older Series Holder', '9552990004', '2026-07-10');
    expect(text).toContain(squash('Debenture Certificate'));
    expect(text).toContain(squash(NEW_CIN));
    expect(text).not.toContain(squash(OLD_CIN));
  });
});
