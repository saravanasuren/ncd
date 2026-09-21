/**
 * Locker rent report (owner 2026-08-22) — every NCD locker with how its rent
 * stands: PAID, WAIVED, PREMIUM, UNPAID — or UNKNOWN when LockerHub could not be
 * read. Feeds both the on-screen report and its Excel export.
 *
 * The status is NOT decided here. It comes from rentDecisions() in rentStatus.ts,
 * the same call Locker Tenants makes, so the two pages cannot disagree; this file
 * only decides WHICH lockers to list and how to lay them out. locker/branch/
 * customer + the live rent leg come from LockerHub (resolved per application,
 * bounded concurrency — a staff report, not a hot path).
 */
import ExcelJS from 'exceljs';
import { RENT_STATUSES, RENT_STATUS_LABEL, type RentStatus } from '@new-wealth/shared';
import type { Db } from '../../db/types.js';
import * as lh from '../../integrations/lockerhub/client.js';
import { rentDecisions } from './rentStatus.js';

export type { RentStatus };

export interface LockerRentRow {
  lockerhub_application_id: string; application_no: string | null;
  locker_no: string | null; branch: string | null; size: string | null;
  customer_name: string | null; customer_code: string | null; phone: string | null;
  rent_amount: number | null; rent_status: RentStatus; reason: string | null;
}

export interface LockerRentReport { rows: LockerRentRow[]; totals: Record<RentStatus, number>; lockerhub_error: string | null }

export async function lockerRentReport(db: Db): Promise<LockerRentReport> {
  let lockerhub_error: string | null = null;
  const last10 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);

  // These three tables were assumed to cover every locker ("every NCD locker
  // carries at least the deposit auto-waiver") — wrong for a tenant who simply
  // paid rent and deposit online with no waiver, no NCD-backed deposit pledge
  // and no cheque: they leave NO row in any of the three, so the report
  // silently excluded them while Locker Tenants (which reads the full
  // LockerHub roster, not these exception tables) showed them fine. The
  // roster is the actual "every occupied locker" list; these tables only ever
  // covered the exceptions to a clean online payment, so it is unioned in
  // rather than relied on alone.
  const localIds = (await db.query<{ id: string }>(
    `SELECT DISTINCT id FROM (
       SELECT lockerhub_application_id AS id FROM locker_fee_waivers
       UNION SELECT lockerhub_application_id FROM locker_deposit_links
       UNION SELECT lockerhub_application_id FROM locker_cheques
     ) t WHERE id IS NOT NULL ORDER BY id LIMIT 500`)).rows.map((r) => String(r.id));

  let rosterIds: string[] = [];
  if (lh.lockerHubConfigured()) {
    try {
      const { tenants } = await lh.lockerTenants();
      rosterIds = (tenants as Array<Record<string, unknown>>)
        .map((t) => String(t.application_id ?? '').trim())
        .filter(Boolean);
    } catch (e) { lockerhub_error = (e as Error).message; }
  }
  const ids = [...new Set([...localIds, ...rosterIds])];

  let branchNames = new Map<string, string>();
  if (lh.lockerHubConfigured()) {
    try { const { branches } = await lh.branches(); branchNames = new Map(branches.map((b) => [String(b.id), b.name])); } catch { /* cosmetic */ }
  }

  // The status, the waivers behind it and the LockerHub application — all from
  // the one shared call. Nothing below re-derives any of it.
  const { decisions, apps, lockerhub_error: readError } = await rentDecisions(db, ids);
  if (!lockerhub_error) lockerhub_error = readError;

  // Match the resolved phones to NCD customers for the code/name.
  const phones = ids.map((id) => last10(apps.get(id)?.phone)).filter((p) => p.length === 10);
  const custByPhone = new Map<string, Record<string, unknown>>();
  if (phones.length) {
    const custs = (await db.query<Record<string, unknown>>(
      "SELECT full_name, customer_code, phone FROM customers WHERE right(regexp_replace(phone,'\\D','','g'),10) = ANY($1)", [phones])).rows;
    for (const c of custs) custByPhone.set(last10(c.phone), c);
  }

  const rows: LockerRentRow[] = ids.map((id) => {
    const app = apps.get(id) ?? null;
    const d = decisions.get(id)!;
    const c = custByPhone.get(last10(app?.phone));
    return {
      lockerhub_application_id: id,
      application_no: (app?.application_no as string) ?? null,
      locker_no: app?.allotment?.locker_number ?? app?.allotment?.locker_no ?? app?.locker_no ?? null,
      branch: (app?.branch_id != null ? branchNames.get(String(app.branch_id)) : null) ?? (app?.branch_name as string) ?? null,
      size: (app?.locker_size as string) ?? null,
      customer_name: (c?.full_name as string) ?? (app?.name as string) ?? null,
      customer_code: (c?.customer_code as string) ?? null,
      phone: (app?.phone as string) ?? null,
      rent_amount: Number(app?.legs?.rent?.amount ?? app?.legs?.rent?.original_amount ?? 0) || null,
      rent_status: d.status,
      reason: d.reason,
    };
  });
  // Allotted lockers first, then by locker number.
  rows.sort((a, b) => (a.locker_no ?? 'zzz').localeCompare(b.locker_no ?? 'zzz'));

  const totals = Object.fromEntries(RENT_STATUSES.map((s) => [s, 0])) as Record<RentStatus, number>;
  for (const r of rows) totals[r.rent_status]++;
  return { rows, totals, lockerhub_error };
}

export async function lockerRentReportXlsx(rep: LockerRentReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Locker rent');
  ws.addRow(['Locker rent report — paid / waived / premium']).eachCell((c) => { c.font = { bold: true, size: 13 }; });
  // "Unknown" only when there is one — the familiar four-part line otherwise.
  const summary = RENT_STATUSES.filter((s) => s !== 'unknown' || rep.totals.unknown > 0)
    .map((s) => `${RENT_STATUS_LABEL[s]}: ${rep.totals[s]}`).join('   ');
  ws.addRow([summary]);
  ws.addRow([]);
  ws.addRow(['S.No', 'Locker', 'Branch', 'Size', 'Customer', 'Customer code', 'Phone', 'Rent', 'Rent status', 'Reason'])
    .eachCell((c) => { c.font = { bold: true }; });
  rep.rows.forEach((r, i) => {
    ws.addRow([
      i + 1, r.locker_no ?? '', r.branch ?? '', r.size ?? '', r.customer_name ?? '', r.customer_code ?? '',
      r.phone ?? '', r.rent_amount ?? '', RENT_STATUS_LABEL[r.rent_status], r.reason ?? '',
    ]);
  });
  ws.columns = [{ width: 6 }, { width: 12 }, { width: 16 }, { width: 12 }, { width: 26 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 40 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
