/**
 * Locker rent report (owner 2026-08-22) — every NCD locker with its rent status:
 * PAID, WAIVED or PREMIUM. Category comes from NCD's own records
 * (`locker_fee_waivers`); locker/branch/customer + the live rent leg come from
 * LockerHub (resolved per application, bounded concurrency — a staff report, not
 * a hot path). Feeds both the on-screen report and its Excel export.
 */
import ExcelJS from 'exceljs';
import type { Db } from '../../db/types.js';
import * as lh from '../../integrations/lockerhub/client.js';

export type RentStatus = 'paid' | 'waived' | 'premium' | 'unpaid';

interface RentWaiver { category: string; waiver_pct: number | null; status: string; reason: string | null }

/**
 * premium > waived (a 100% discretionary waiver) > paid/unpaid (the LockerHub
 * rent leg). The STANDARD partial GST waiver does NOT count as "waived" — the
 * customer still pays the base, so it stays "paid".
 */
export function rentStatusOf(app: Record<string, any> | null, rentWaivers: RentWaiver[]): RentStatus {
  const approved = rentWaivers.filter((w) => w.status === 'Approved');
  if (approved.some((w) => w.category === 'premium')) return 'premium';
  if (approved.some((w) => w.category === 'waiver' && Number(w.waiver_pct) === 100)) return 'waived';
  const leg = app?.legs?.rent;
  const settled = leg?.settled === true || /paid|settled|success|complete/i.test(String(leg?.status ?? ''));
  return settled ? 'paid' : 'unpaid';
}

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

  // Every NCD locker carries at least the deposit auto-waiver, so fee_waivers
  // covers them all; pledges + cheques folded in for completeness.
  const ids = (await db.query<{ id: string }>(
    `SELECT DISTINCT id FROM (
       SELECT lockerhub_application_id AS id FROM locker_fee_waivers
       UNION SELECT lockerhub_application_id FROM locker_deposit_links
       UNION SELECT lockerhub_application_id FROM locker_cheques
     ) t WHERE id IS NOT NULL ORDER BY id LIMIT 500`)).rows.map((r) => String(r.id));

  const waiverRows = (await db.query<Record<string, any>>(
    "SELECT lockerhub_application_id, category, waiver_pct, status, reason FROM locker_fee_waivers WHERE leg = 'rent'")).rows;
  const wByApp = new Map<string, RentWaiver[]>();
  for (const w of waiverRows) {
    const k = String(w.lockerhub_application_id);
    if (!wByApp.has(k)) wByApp.set(k, []);
    wByApp.get(k)!.push({ category: String(w.category ?? 'waiver'), waiver_pct: w.waiver_pct == null ? null : Number(w.waiver_pct), status: String(w.status), reason: (w.reason as string) ?? null });
  }

  let branchNames = new Map<string, string>();
  if (lh.lockerHubConfigured()) {
    try { const { branches } = await lh.branches(); branchNames = new Map(branches.map((b) => [String(b.id), b.name])); } catch { /* cosmetic */ }
  }

  // Resolve each application against LockerHub (bounded concurrency).
  const resolved: Array<{ id: string; app: Record<string, any> | null }> = [];
  const CHUNK = 6;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const out = await Promise.all(ids.slice(i, i + CHUNK).map(async (id) => {
      if (!lh.lockerHubConfigured()) return { id, app: null };
      try { return { id, app: await lh.getLockerApplication(id) as Record<string, any> }; }
      catch (e) { if (!lockerhub_error) lockerhub_error = (e as Error).message; return { id, app: null }; }
    }));
    resolved.push(...out);
  }

  // Match the resolved phones to NCD customers for the code/name.
  const phones = resolved.map((x) => last10(x.app?.phone)).filter((p) => p.length === 10);
  const custByPhone = new Map<string, Record<string, unknown>>();
  if (phones.length) {
    const custs = (await db.query<Record<string, unknown>>(
      "SELECT full_name, customer_code, phone FROM customers WHERE right(regexp_replace(phone,'\\D','','g'),10) = ANY($1)", [phones])).rows;
    for (const c of custs) custByPhone.set(last10(c.phone), c);
  }

  const rows: LockerRentRow[] = resolved.map(({ id, app }) => {
    const rw = wByApp.get(id) ?? [];
    const status = rentStatusOf(app, rw);
    const flag = rw.find((w) => w.status === 'Approved' && (w.category === 'premium' || Number(w.waiver_pct) === 100));
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
      rent_status: status,
      reason: flag?.reason ?? null,
    };
  });
  // Allotted lockers first, then by locker number.
  rows.sort((a, b) => (a.locker_no ?? 'zzz').localeCompare(b.locker_no ?? 'zzz'));

  const totals: Record<RentStatus, number> = { paid: 0, waived: 0, premium: 0, unpaid: 0 };
  for (const r of rows) totals[r.rent_status]++;
  return { rows, totals, lockerhub_error };
}

const STATUS_LABEL: Record<RentStatus, string> = { paid: 'Paid', waived: 'Waived', premium: 'Premium', unpaid: 'Unpaid' };

export async function lockerRentReportXlsx(rep: LockerRentReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Locker rent');
  ws.addRow(['Locker rent report — paid / waived / premium']).eachCell((c) => { c.font = { bold: true, size: 13 }; });
  ws.addRow([`Paid: ${rep.totals.paid}   Waived: ${rep.totals.waived}   Premium: ${rep.totals.premium}   Unpaid: ${rep.totals.unpaid}`]);
  ws.addRow([]);
  ws.addRow(['S.No', 'Locker', 'Branch', 'Size', 'Customer', 'Customer code', 'Phone', 'Rent', 'Rent status', 'Reason'])
    .eachCell((c) => { c.font = { bold: true }; });
  rep.rows.forEach((r, i) => {
    ws.addRow([
      i + 1, r.locker_no ?? '', r.branch ?? '', r.size ?? '', r.customer_name ?? '', r.customer_code ?? '',
      r.phone ?? '', r.rent_amount ?? '', STATUS_LABEL[r.rent_status], r.reason ?? '',
    ]);
  });
  ws.columns = [{ width: 6 }, { width: 12 }, { width: 16 }, { width: 12 }, { width: 26 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 40 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
