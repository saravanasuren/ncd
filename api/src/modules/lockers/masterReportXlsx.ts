/**
 * The Locker Master Report as an Excel book, built with the same furniture as
 * the NCD book (reports/xlsx.ts) because the owner asked for it "like how u
 * have a report for ncd" — same navy header, same money format, same
 * collapsible groups.
 *
 * Tabs, in order:
 *   Locker Summary · Master Lockers · Hirers · Agreements · Rent & Deposit · Vacant
 *
 * Every tab is cut from the ONE report object, so no two tabs can disagree
 * about a locker. Streamed, like the NCD book.
 */
import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import { RENT_STATUS_LABEL, type RentStatus } from '@new-wealth/shared';
import { startSheet, boldRow, outlineSheet, fmtDate } from '../reports/xlsx.js';
import type { LockerMasterReport, LockerMasterRow } from './masterReport.js';

const dash = (v: unknown): string => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? '—' : s;
};

/** The one shared vocabulary — "Paid", not "paid", and the same word the Rent
 *  Report and Locker Tenants print. */
const rentLabel = (s: RentStatus | null): string => (s ? RENT_STATUS_LABEL[s] : '—');

export async function buildLockerMasterBook(out: Writable, rep: LockerMasterReport): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  wb.creator = 'Dhanam NCD';

  const occupied = rep.rows.filter((r) => r.occupancy === 'Occupied');
  const vacant = rep.rows.filter((r) => r.occupancy === 'Vacant');

  // ── Tab 1 — Locker Summary: the stock position, branch by branch ──────────
  const ws1 = startSheet(wb, 'Locker Summary', [
    { header: 'Branch', width: 26 }, { header: 'Lockers', width: 10 },
    { header: 'Occupied', width: 10 }, { header: 'Vacant', width: 10 },
    { header: 'Occupancy %', width: 13 },
  ]);
  // A null percentage is printed as a dash, never as a number: see
  // LockerBranchSummary.occupancy_pct.
  for (const b of rep.branches) {
    ws1.addRow([b.branch, b.total, b.occupied, b.vacant, b.occupancy_pct ?? '—']).commit();
  }
  boldRow(ws1, ['Grand Total', rep.totals.lockers, rep.totals.occupied, rep.totals.vacant,
    rep.totals.occupancy_pct ?? '—']);
  // The caveats belong on the face of the report, not in a covering email.
  ws1.addRow([]).commit();
  boldRow(ws1, ['Notes']);
  ws1.addRow([`Generated ${fmtDate(rep.generated_at)}`]).commit();
  ws1.addRow([`Agreements signed: ${rep.totals.agreement_signed} of ${rep.totals.occupied} occupied`]).commit();
  ws1.addRow([`Rent unpaid: ${rep.totals.rent_unpaid}`]).commit();
  if (rep.vacant_unavailable) {
    ws1.addRow(['VACANT LOCKERS COULD NOT BE READ from LockerHub — the vacant and'
      + ' occupancy figures above are incomplete. Occupied rows are unaffected.']).commit();
  }
  if (rep.lockerhub_error) ws1.addRow([`LockerHub error: ${rep.lockerhub_error}`]).commit();
  await ws1.commit();

  // ── Tab 2 — Master Lockers: one row per physical locker ───────────────────
  const ws2 = startSheet(wb, 'Master Lockers', [
    { header: 'Branch', width: 22 }, { header: 'Locker No', width: 12 }, { header: 'Size', width: 12 },
    { header: 'Status', width: 11 }, { header: 'Hirer', width: 28 }, { header: 'Customer ID', width: 13 },
    { header: 'Phone', width: 14 }, { header: 'Allotted On', width: 14 },
    { header: 'Agreement', width: 16 }, { header: 'Rent', width: 13, money: true },
    { header: 'Rent Status', width: 13 }, { header: 'Deposit', width: 14, money: true },
  ]);
  for (const r of rep.rows) {
    ws2.addRow([
      dash(r.branch), dash(r.locker_no), dash(r.size), r.occupancy,
      dash(r.customer_name), dash(r.customer_code), dash(r.phone),
      r.allotted_on ? fmtDate(r.allotted_on) : '—',
      r.occupancy === 'Occupied' ? dash(r.agreement_status) : '—',
      r.rent_amount ?? null, rentLabel(r.rent_status),
      r.deposit_amount ?? null,
    ]).commit();
  }
  boldRow(ws2, [`${rep.totals.lockers} lockers`, '', '', `${rep.totals.occupied} occupied / ${rep.totals.vacant} vacant`,
    '', '', '', '', '', null, '', rep.totals.deposit_linked]);
  await ws2.commit();

  // ── Tab 3 — Hirers: a customer, expanded to the locker(s) they hold ───────
  const byHirer = new Map<string, LockerMasterRow[]>();
  for (const r of occupied) {
    const key = `${r.customer_name ?? '(name not known)'}\u0000${r.customer_code ?? ''}`;
    (byHirer.get(key) ?? byHirer.set(key, []).get(key)!).push(r);
  }
  await outlineSheet(wb, 'Hirers', [
    { header: 'Hirer', width: 30 }, { header: 'Customer ID', width: 13 }, { header: 'Phone', width: 14 },
    { header: 'Branch', width: 20 }, { header: 'Locker No', width: 12 }, { header: 'Size', width: 12 },
    { header: 'Joint Hirers', width: 30 }, { header: 'Authorised Users', width: 30 },
    { header: 'Rent', width: 13, money: true },
  ],
  [...byHirer.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, items]) => {
      const [name, code] = key.split('\u0000');
      return {
        summary: [name, code || '—', dash(items[0]!.phone), `${items.length} locker${items.length === 1 ? '' : 's'}`,
          '', '', '', '', items.reduce((s, r) => s + (r.rent_amount ?? 0), 0)],
        details: items.map((r) => ['', '', '', dash(r.branch), dash(r.locker_no), dash(r.size),
          dash(r.joint_hirers), dash(r.authorised_users), r.rent_amount ?? null]),
      };
    }),
  ['Grand Total', '', '', `${occupied.length} lockers`, '', '', '', '',
    occupied.reduce((s, r) => s + (r.rent_amount ?? 0), 0)]);

  // ── Tab 4 — Agreements: signed, and conspicuously not signed ──────────────
  const ws4 = startSheet(wb, 'Agreements', [
    { header: 'Branch', width: 22 }, { header: 'Locker No', width: 12 }, { header: 'Hirer', width: 28 },
    { header: 'Agreement No', width: 18 }, { header: 'Status', width: 18 },
    { header: 'Method', width: 12 }, { header: 'Signed On', width: 14 }, { header: 'Allotted On', width: 14 },
  ]);
  // Unsigned first: the point of this tab is the gap, so it should not need
  // scrolling to.
  const agreementOrder = [...occupied].sort((a, b) => {
    const as = a.agreement_status === 'Signed' ? 1 : 0;
    const bs = b.agreement_status === 'Signed' ? 1 : 0;
    return as - bs || (a.branch ?? '').localeCompare(b.branch ?? '');
  });
  for (const r of agreementOrder) {
    ws4.addRow([dash(r.branch), dash(r.locker_no), dash(r.customer_name), dash(r.agreement_no),
      dash(r.agreement_status), dash(r.agreement_method),
      r.signed_on ? fmtDate(r.signed_on) : '—',
      r.allotted_on ? fmtDate(r.allotted_on) : '—']).commit();
  }
  boldRow(ws4, [`${rep.totals.agreement_signed} signed`, `${rep.totals.agreement_missing} not signed`,
    '', '', '', '', '', '']);
  await ws4.commit();

  // ── Tab 5 — Rent & Deposit ────────────────────────────────────────────────
  const ws5 = startSheet(wb, 'Rent & Deposit', [
    { header: 'Branch', width: 22 }, { header: 'Locker No', width: 12 }, { header: 'Hirer', width: 28 },
    { header: 'Customer ID', width: 13 }, { header: 'Rent', width: 13, money: true },
    { header: 'Rent Status', width: 13 }, { header: 'Deposit Linked', width: 15, money: true },
    { header: 'Backing NCD', width: 20 },
  ]);
  for (const r of occupied) {
    ws5.addRow([dash(r.branch), dash(r.locker_no), dash(r.customer_name), dash(r.customer_code),
      r.rent_amount ?? null, rentLabel(r.rent_status), r.deposit_amount ?? null, dash(r.deposit_ncd_app_no)]).commit();
  }
  boldRow(ws5, ['Grand Total', '', '', '',
    occupied.reduce((s, r) => s + (r.rent_amount ?? 0), 0), '', rep.totals.deposit_linked, '']);
  await ws5.commit();

  // ── Tab 6 — Vacant: what can be sold tomorrow ─────────────────────────────
  const ws6 = startSheet(wb, 'Vacant', [
    { header: 'Branch', width: 26 }, { header: 'Locker No', width: 14 }, { header: 'Size', width: 14 },
  ]);
  if (rep.vacant_unavailable && !vacant.length) {
    ws6.addRow(['LockerHub could not be read — vacant lockers are not listed.']).commit();
  }
  for (const r of vacant) ws6.addRow([dash(r.branch), dash(r.locker_no), dash(r.size)]).commit();
  boldRow(ws6, [`${vacant.length} vacant`, '', '']);
  await ws6.commit();

  await wb.commit();
}
