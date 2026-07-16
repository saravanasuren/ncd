/**
 * migrate-legacy/pipeline.ts — the transform + load core.
 *
 * Reads a LegacySource, writes into a freshly-migrated target `Db`, preserving
 * old integer PKs as the new BIGINT PKs so every foreign key lines up with no
 * id-remapping. Money copies rupees→rupees 1:1. The schedule step implements the
 * owner's freeze/recompute rule (see config.INTEREST_ANCHOR).
 *
 * Every row insert is isolated: a bad row is counted as an anomaly and the run
 * continues, so a dry-run surfaces ALL data problems in one pass instead of
 * aborting on the first. Dry-run wraps the whole load in a transaction that is
 * rolled back at the end — nothing persists.
 */
import type { Db } from '../db/types.js';
import { generateSchedule } from '../lib/interest.js';
import { computeTds } from '../lib/tds.js';
import { addMonths, toISODate } from '../lib/dates.js';
import type { LegacySource, Row } from './source.js';
import {
  INTEREST_ANCHOR,
  ROLE_MAP,
  ROLE_FALLBACK,
  AGENT_COMMISSION_STATUS_MAP,
  RECOMPUTE_APP_STATUSES,
  DUE_TYPE_MAP,
  SCHEDULE_STATUS_MAP,
  DEFAULT_TDS_RATE_PCT,
} from './config.js';

export interface TableStat {
  table: string;
  source: number;
  loaded: number;
  failed: number;
  note?: string;
}

export interface MigrationReport {
  sourceLabel: string;
  anchor: string;
  dryRun: boolean;
  tables: TableStat[];
  roleMapping: { oldRole: string; newRole: string; mapped: boolean }[];
  aum: { activeSource: number; activeLoaded: number };
  interest: {
    frozenRows: number; // loaded rows due_date <= anchor
    regeneratedRows: number; // new Scheduled rows due_date > anchor
    oldPaidRows: number; // source rows with status Paid
    loadedPaidRows: number; // loaded rows with status Paid
  };
  sample?: {
    applicationNo: string;
    oldFuture: { due_date: string; due_type: string; gross: number; status: string }[];
    newFuture: { due_date: string; due_type: string; gross: number; period_days: number }[];
  };
  anomalies: string[];
}

const num = (v: any): number => (v == null || v === '' ? 0 : Number(v));
const d = (v: any): string | null => toISODate(v);
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Insert one object as a parameterised row. */
async function insertRow(tx: Db, table: string, obj: Record<string, any>): Promise<void> {
  const cols = Object.keys(obj);
  const vals = cols.map((c) => obj[c]);
  const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
  await tx.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`, vals);
}

/** Insert many objects (same column set) in one multi-row INSERT. */
async function insertMulti(tx: Db, table: string, objs: Record<string, any>[]): Promise<void> {
  if (!objs.length) return;
  const cols = Object.keys(objs[0]!);
  const params: any[] = [];
  const tuples = objs.map((o) => `(${cols.map((c) => `$${params.push(o[c])}`).join(',')})`);
  await tx.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
}

/**
 * Batch-insert with per-row fallback: try a chunk in one statement (fast); if the
 * chunk fails (a bad row), retry that chunk row-by-row to isolate the offender as
 * an anomaly while keeping the good rows. Keeps the load fast AND diagnostic.
 */
async function insertBatch(
  tx: Db,
  table: string,
  objs: Record<string, any>[],
  onAnomaly: (obj: Record<string, any>, err: Error) => void
): Promise<{ loaded: number; failed: number }> {
  let loaded = 0, failed = 0;
  const CHUNK = 400;
  for (let i = 0; i < objs.length; i += CHUNK) {
    const chunk = objs.slice(i, i + CHUNK);
    try {
      await insertMulti(tx, table, chunk);
      loaded += chunk.length;
    } catch {
      for (const o of chunk) {
        try { await insertRow(tx, table, o); loaded++; }
        catch (e: any) { failed++; onAnomaly(o, e); }
      }
    }
  }
  return { loaded, failed };
}

/** Progress to stderr so stdout stays a clean report. */
const progress = (m: string) => process.stderr.write(`[migrate-legacy] ${m}\n`);

export async function runMigration(
  source: LegacySource,
  target: Db,
  opts: { dryRun?: boolean } = {}
): Promise<MigrationReport> {
  const dryRun = opts.dryRun !== false; // default TRUE
  const anchor = INTEREST_ANCHOR;
  const anomalies: string[] = [];
  const tables: TableStat[] = [];

  const report: MigrationReport = {
    sourceLabel: source.label(),
    anchor,
    dryRun,
    tables,
    roleMapping: [],
    aum: { activeSource: 0, activeLoaded: 0 },
    interest: { frozenRows: 0, regeneratedRows: 0, oldPaidRows: 0, loadedPaidRows: 0 },
    anomalies,
  };

  // Read everything up-front (deterministic).
  progress('reading legacy tables…');
  const [
    oldRoles, oldBranches, oldUsers, oldAgents, oldBanks, oldTds, oldHolidays,
    oldCompany, oldSchemes, oldSeries, oldSeriesSchemes, oldLeads, oldCustomers,
    oldBankAccts, oldNominees, oldJoint, oldApps, oldLines, oldSchedule,
    oldRedemptions, oldIncentives,
  ] = await Promise.all([
    source.roles(), source.branches(), source.users(), source.agents(), source.banks(),
    source.tdsRules(), source.holidays(), source.companyProfile(), source.schemes(),
    source.series(), source.seriesSchemes(), source.leads(), source.customers(),
    source.customerBankAccounts(), source.nominees(), source.jointHolders(),
    source.applications(), source.applicationLines(), source.schedule(),
    source.redemptions(), source.incentiveAccruals(),
  ]);
  progress(
    `read: ${oldCustomers.length} customers, ${oldApps.length} applications, ` +
    `${oldLines.length} lines, ${oldSchedule.length} schedule rows`
  );

  const holidayISO = oldHolidays.map((h) => d(h.holiday_date)).filter(Boolean) as string[];

  const run = async (tx: Db) => {
    // ── role name maps ────────────────────────────────────────────────
    const oldRoleName = new Map<any, string>(); // old role id → old role name
    for (const r of oldRoles) oldRoleName.set(r.id, r.name);
    const newRoleId = new Map<string, number>(); // new role name → new role id
    const nr = await tx.query<{ id: number; name: string }>('SELECT id, name FROM roles');
    for (const r of nr.rows) newRoleId.set(r.name, Number(r.id));
    // resolved mapping for the report
    const seenRoles = new Set<string>();
    for (const oldName of oldRoleName.values()) {
      if (seenRoles.has(oldName)) continue;
      seenRoles.add(oldName);
      const mapped = ROLE_MAP[oldName];
      report.roleMapping.push({ oldRole: oldName, newRole: mapped ?? ROLE_FALLBACK, mapped: !!mapped });
    }
    const resolveRole = (oldRoleId: any): number => {
      const oldName = oldRoleName.get(oldRoleId) ?? 'agent';
      const newName = ROLE_MAP[oldName] ?? ROLE_FALLBACK;
      return newRoleId.get(newName) ?? newRoleId.get('agent')!;
    };

    // helper: map rows → batch-insert (fast) with per-row fallback isolation
    const load = async (
      table: string,
      rows: Row[],
      map: (r: Row) => Record<string, any> | null
    ): Promise<TableStat> => {
      let failed = 0;
      const objs: Record<string, any>[] = [];
      for (const r of rows) {
        let obj: Record<string, any> | null;
        try {
          obj = map(r);
        } catch (e: any) {
          failed++; if (anomalies.length < 200) anomalies.push(`${table} id=${r.id}: map error ${e.message}`); continue;
        }
        if (obj) objs.push(obj);
      }
      const res = await insertBatch(tx, table, objs, (o, e) => {
        if (anomalies.length < 200) anomalies.push(`${table} id=${o.id ?? '?'}: ${e.message}`);
      });
      failed += res.failed;
      const stat = { table, source: rows.length, loaded: res.loaded, failed };
      tables.push(stat);
      progress(`${table}: ${res.loaded}/${rows.length}${failed ? ` (${failed} failed)` : ''}`);
      return stat;
    };

    // ── masters ───────────────────────────────────────────────────────
    await load('branches', oldBranches, (r) => ({
      id: r.id, code: r.code, name: r.name, city: r.city,
      district: r.district ?? r.city ?? null, state: r.state,
      is_active: r.is_active ?? true,
    }));

    await load('users', oldUsers, (r) => ({
      id: r.id, email: r.email, password_hash: r.password_hash,
      full_name: r.full_name, phone: r.phone, role_id: resolveRole(r.role_id),
      branch_id: r.branch_id ?? null, reports_to_user_id: r.reports_to_user_id ?? null,
      is_active: r.is_active ?? true,
    }));

    await load('agents', oldAgents, (r) => ({
      id: r.id, user_id: null, agent_code: r.agent_code, full_name: r.full_name,
      phone: r.phone, email: r.email, source: 'manual',
      commission_status: AGENT_COMMISSION_STATUS_MAP[r.commission_eligibility_status] ?? 'None',
      payout_mode: r.commission_payout_mode ?? null,
      bank_name: r.payout_bank_name ?? null, account_number: r.payout_account_number ?? null,
      ifsc: r.payout_ifsc ?? null, is_active: r.is_active ?? true,
    }));

    await load('banks', oldBanks, (r) => ({
      id: r.id, account_label: r.account_label, bank_name: r.bank_name,
      account_number: r.account_number ?? null, ifsc: r.ifsc ?? null,
      is_collection_account: r.is_collection_account ?? false,
      is_disbursement_account: r.is_disbursement_account ?? false,
      is_active: r.is_active ?? true,
    }));

    await load('tds_rules', oldTds, (r) => ({
      id: r.id, name: r.name, kind: 'standard', rate_pct: num(r.rate_pct),
      threshold: r.threshold_amount ?? null, is_active: r.is_active ?? true,
    }));

    await load('holidays', oldHolidays, (r) => {
      const day = d(r.holiday_date);
      return day ? { d: day, label: r.holiday_name ?? null } : null;
    });

    if (oldCompany[0]) {
      const c = oldCompany[0];
      try {
        await tx.query('DELETE FROM company_profile WHERE id = 1');
        await insertRow(tx, 'company_profile', {
          id: 1, legal_name: c.legal_name ?? 'Dhanam Investment and Finance Private Limited',
          former_legal_name: c.former_legal_name ?? null, short_name: c.legal_name_short ?? 'Dhanam',
          tan: c.tan ?? null, tan_holder_name: c.tan_holder_name ?? null,
          tan_amendment_pending: c.tan_amendment_pending ?? false,
          signatory_name: c.signatory_name ?? null, signatory_designation: c.signatory_designation ?? null,
        });
        tables.push({ table: 'company_profile', source: 1, loaded: 1, failed: 0 });
      } catch (e: any) {
        tables.push({ table: 'company_profile', source: 1, loaded: 0, failed: 1, note: e.message });
      }
    }

    await load('schemes', oldSchemes, (r) => ({
      id: r.id, code: r.code, name: r.name, tenure_months: num(r.tenure_months),
      payout_frequency: r.payout_frequency ?? 'Monthly', coupon_rate_pct: num(r.coupon_rate_pct),
      face_value: num(r.face_value) || 100000, min_ticket: num(r.min_ticket_amount) || 100000,
      multiple_of: num(r.multiple_of) || 100000,
      day_count_convention: r.day_count_convention ?? 'Actual365',
      commission_rule: r.commission_type ?? 'OneTime', tds_rule_id: r.tds_rule_id ?? null,
      is_active: r.is_active ?? true,
    }));

    await load('series', oldSeries, (r) => ({
      id: r.id, code: r.code, name: r.name, status: mapSeriesStatus(r.status),
      face_value: r.face_value ?? null,
      deemed_date: d(r.deemed_date_of_allotment), isin: r.isin_number ?? r.isin ?? null,
      opened_at: r.open_date ? d(r.open_date) : null,
      locked_at: r.locked_at ?? null, allotted_at: r.allotted_at ?? null,
    }));

    await load('series_schemes', oldSeriesSchemes, (r) => ({
      series_id: r.series_id, scheme_id: r.scheme_id,
    }));

    await load('investor_leads', oldLeads, (r) => ({
      id: r.id, full_name: r.full_name, phone: r.phone,
      place: r.city ?? r.place ?? null, district: r.district ?? null,
      category: r.investor_category ?? null, source: r.source ?? null,
      referred_by_text: r.referred_by ?? null, interested_scheme: r.interested_scheme ?? null,
      expected_amount: r.expected_amount ?? null, follow_up_date: d(r.follow_up_date),
      status: r.lead_status ?? 'New', notes: r.notes ?? null,
      admin_only: r.admin_only ?? false, created_by_user_id: r.created_by_user_id ?? null,
      created_by_agent_id: r.assigned_to_agent_id ?? r.referred_by_agent_id ?? null,
      branch_id: null, converted_customer_id: r.converted_customer_id ?? null,
      lockerhub_application_no: r.lockerhub_application_no ?? null,
    }));

    // ── customer graph ─────────────────────────────────────────────────
    const custById = new Map<any, Row>();
    for (const c of oldCustomers) custById.set(c.id, c);

    await load('customers', oldCustomers, (r) => ({
      id: r.id, customer_code: r.customer_code, full_name: r.full_name,
      pan: r.pan ?? null, dob: d(r.date_of_birth ?? r.dob),
      gender: r.gender ?? null, phone: r.phone_primary ?? r.phone ?? null, email: r.email ?? null,
      address: r.address_line1 ?? r.address ?? null, city: r.city ?? null,
      district: r.district ?? r.city ?? null, state: r.state ?? null,
      is_nri: r.is_nri ?? false, tax_form: r.tax_form ?? null,
      tax_form_expires_on: d(r.tax_form_expires_on),
      tds_applicable: r.tds_applicable ?? true, referred_by_text: r.referred_by_free_text ?? null,
      kyc_status: r.kyc_status ?? 'Pending', creation_status: r.creation_status ?? 'Approved',
      enrolled_by_user_id: r.enrolled_by_user_id ?? null,
      enrolled_by_agent_id: r.enrolled_by_agent_id ?? null, branch_id: r.branch_id ?? null,
      is_active: r.is_active ?? true, is_deceased: r.is_deceased ?? false,
      deceased_date: d(r.deceased_date), portal_user_id: null,
    }));

    await load('customer_bank_accounts', oldBankAccts, (r) => ({
      id: r.id, customer_id: r.customer_id, account_number: r.bank_account_number,
      ifsc: r.bank_ifsc ?? null, bank_name: r.bank_name ?? null,
      branch_name: r.bank_branch_name ?? null, holder_name: r.bank_beneficiary_name ?? null,
      penny_drop_status: r.penny_drop_status ?? 'Pending', penny_drop_detail: r.penny_drop_ref ?? null,
      is_active: r.is_active ?? false, verified_at: r.penny_drop_verified_at ?? null,
    }));

    await load('nominees', oldNominees, (r) => ({
      id: r.id, customer_id: r.customer_id, full_name: r.full_name,
      relationship: r.relationship ?? null, share_pct: r.share_pct ?? null, dob: d(r.date_of_birth),
    }));

    await load('joint_holders', oldJoint, (r) => ({
      id: r.id, customer_id: r.customer_id, full_name: r.full_name,
      pan: r.pan ?? null, phone: r.phone ?? null, relationship: r.relationship ?? null,
    }));

    // ── investments ────────────────────────────────────────────────────
    const linesByApp = new Map<any, Row[]>();
    const appIdByLine = new Map<any, any>();
    for (const l of oldLines) {
      if (!linesByApp.has(l.application_id)) linesByApp.set(l.application_id, []);
      linesByApp.get(l.application_id)!.push(l);
      appIdByLine.set(l.id, l.application_id);
    }
    const appById = new Map<any, Row>();
    for (const a of oldApps) appById.set(a.id, a);

    await load('applications', oldApps, (r) => {
      const lines = linesByApp.get(r.id) ?? [];
      const isd = lines.map((l) => d(l.interest_start_date)).filter(Boolean).sort()[0] ?? null;
      const status = mapAppStatus(r.status);
      if (status === 'Active') report.aum.activeSource += num(r.total_amount);
      return {
        id: r.id, application_no: r.application_no, customer_id: r.customer_id,
        series_id: r.series_id, status,
        total_amount: num(r.total_amount),
        amount_received: r.amount_received ?? null, date_money_received: d(r.date_money_received),
        collection_method: r.collection_method ?? null, collection_reference: r.collection_reference ?? null,
        interest_start_date: isd, allotment_date: d(r.allotment_date),
        maturity_date: d(r.maturity_date), redemption_date: d(r.redemption_date),
        batch_allotment_id: null,
        payout_bank_account_id: r.payout_bank_account_id ?? null,
        customer_was_new_at_creation: r.customer_was_new_at_creation ?? true,
        is_locker_deposit: r.is_locker_deposit ?? false,
        referred_by_text: r.referred_by_free_text ?? null,
        source: r.lockerhub_intent_no ? 'lockerhub' : 'staff',
        enrolled_by_user_id: r.enrolled_by_user_id ?? null,
        enrolled_by_agent_id: r.enrolled_by_agent_id ?? null,
      };
    });

    await load('application_lines', oldLines, (r) => ({
      id: r.id, application_id: r.application_id, scheme_id: r.scheme_id ?? null,
      coupon_rate_pct: num(r.coupon_rate_pct), tenure_months: num(r.tenure_months),
      payout_frequency: r.payout_frequency ?? 'Monthly',
      day_count_convention: r.day_count_convention ?? 'Actual365',
      amount: num(r.amount), outstanding_amount: num(r.outstanding_amount ?? r.amount),
      maturity_date: d(r.maturity_date), status: r.status ?? 'Active',
    }));

    // ── schedule: freeze + recompute ────────────────────────────────────
    const stdTds = { rate_pct: DEFAULT_TDS_RATE_PCT };
    const oldSchedByLine = new Map<any, Row[]>();
    for (const s of oldSchedule) {
      if (!oldSchedByLine.has(s.application_line_id)) oldSchedByLine.set(s.application_line_id, []);
      oldSchedByLine.get(s.application_line_id)!.push(s);
      if ((s.status ?? '') === 'Paid') report.interest.oldPaidRows++;
    }

    // Build every schedule row (freeze + recompute) into one array, then bulk
    // insert. On a real book this is tens of thousands of rows — batching turns
    // that from many minutes of one-at-a-time inserts into seconds.
    progress(`schedule: building rows for ${oldLines.length} lines…`);
    const schedRows: Record<string, any>[] = [];
    let regenPushed = 0;
    let schedMapFailed = 0;
    let samplePicked = false;

    for (const line of oldLines) {
      const appId = line.application_id;
      const app = appById.get(appId);
      if (!app) continue;
      const appStatus = mapAppStatus(app.status);
      const cust = custById.get(app.customer_id) ?? {};
      const oldRows = oldSchedByLine.get(line.id) ?? [];
      const recompute =
        RECOMPUTE_APP_STATUSES.has(appStatus) &&
        (line.status ?? 'Active') === 'Active' &&
        d(line.maturity_date) !== null &&
        d(line.maturity_date)! > anchor;

      // 1) FREEZE: old rows on/before the anchor kept verbatim. If NOT
      //    recomputing (matured/redeemed), keep ALL old rows verbatim.
      for (const s of oldRows) {
        const due = d(s.due_date);
        if (!due) { schedMapFailed++; continue; }
        const keep = recompute ? due <= anchor : true;
        if (!keep) continue;
        const gross = num(s.gross_amount);
        const tds = num(s.tds_amount);
        schedRows.push({
          line_id: line.id, application_id: appId, due_date: due,
          due_type: DUE_TYPE_MAP[s.due_type] ?? 'Interest',
          gross_amount: gross, tds_amount: tds, net_amount: round2(gross - tds),
          status: SCHEDULE_STATUS_MAP[s.status] ?? 'Scheduled', paid_at: d(s.paid_at), utr: s.utr ?? null,
          payee_account: s.account_number_snapshot ?? null, payee_ifsc: s.ifsc_snapshot ?? null,
          failure_reason: s.failure_reason ?? null,
        });
      }

      // 2) RECOMPUTE: future interest for live lines, engine-driven.
      if (!recompute) continue;
      const maturity = d(line.maturity_date)!;
      const tenure = num(line.tenure_months);
      const seriesDeemed = addMonths(maturity, -tenure); // makes engine maturity == old maturity
      let rows;
      try {
        rows = generateSchedule(
          {
            amount: num(line.amount), coupon_rate_pct: num(line.coupon_rate_pct),
            payout_frequency: line.payout_frequency ?? 'Monthly',
            tenure_months: tenure, day_count_convention: line.day_count_convention ?? 'Actual365',
          },
          { interestStartDate: anchor, seriesDeemedDate: seriesDeemed, holidays: holidayISO, payoutDay: 28 }
        );
      } catch (e: any) {
        if (anomalies.length < 200) anomalies.push(`recompute line=${line.id}: ${e.message}`);
        continue;
      }
      const future = rows.filter((rw) => rw.due_date > anchor);
      const newFutureForSample: any[] = [];
      for (const rw of future) {
        const tdsAmt = computeTds(
          stdTds,
          { is_nri: cust.is_nri, tds_applicable: cust.tds_applicable, tax_form: cust.tax_form, tax_form_expires_on: d(cust.tax_form_expires_on) },
          { payout_frequency: line.payout_frequency, amount: num(line.amount), tds_applicable: line.tds_applicable ?? null },
          { due_type: rw.due_type, gross_amount: rw.gross_amount, due_date: rw.due_date }
        );
        schedRows.push({
          line_id: line.id, application_id: appId, due_date: rw.due_date,
          due_type: rw.due_type, gross_amount: rw.gross_amount, tds_amount: tdsAmt,
          net_amount: round2(rw.gross_amount - tdsAmt), status: 'Scheduled',
          paid_at: null, utr: null, payee_account: null, payee_ifsc: null, failure_reason: null,
        });
        regenPushed++;
        newFutureForSample.push({ due_date: rw.due_date, due_type: rw.due_type, gross: rw.gross_amount, period_days: rw.period_days });
      }

      // capture the first good sample (an app that actually regenerated rows)
      if (!samplePicked && newFutureForSample.length > 0) {
        const oldFuture = oldRows
          .filter((s) => (d(s.due_date) ?? '') > anchor)
          .map((s) => ({ due_date: d(s.due_date)!, due_type: s.due_type, gross: num(s.gross_amount), status: s.status }));
        report.sample = { applicationNo: app.application_no, oldFuture, newFuture: newFutureForSample };
        samplePicked = true;
      }
    }

    progress(`schedule: inserting ${schedRows.length} rows…`);
    const schedRes = await insertBatch(tx, 'disbursement_schedule', schedRows, (o, e) => {
      if (anomalies.length < 200) anomalies.push(`schedule line=${o.line_id} due=${o.due_date}: ${e.message}`);
    });
    tables.push({ table: 'disbursement_schedule', source: oldSchedule.length, loaded: schedRes.loaded, failed: schedRes.failed + schedMapFailed });
    report.interest.regeneratedRows = regenPushed;
    // frozen / paid counts straight from what actually landed (accurate even if a row failed)
    const frozenR = await tx.query<{ n: string }>('SELECT COUNT(*) AS n FROM disbursement_schedule WHERE due_date <= $1', [anchor]);
    report.interest.frozenRows = Number(frozenR.rows[0]?.n ?? 0);
    const paidR = await tx.query<{ n: string }>("SELECT COUNT(*) AS n FROM disbursement_schedule WHERE status='Paid'");
    report.interest.loadedPaidRows = Number(paidR.rows[0]?.n ?? 0);
    progress(`schedule: ${schedRes.loaded}/${schedRows.length} loaded, ${regenPushed} regenerated`);

    // ── redemptions ─────────────────────────────────────────────────────
    await load('redemptions', oldRedemptions, (r, ) => {
      // old redemptions may target multiple apps historically; new requires an app.
      if (!r.application_id) return null;
      return {
        id: r.id, redemption_no: r.request_no ?? `RED-LEGACY-${r.id}`,
        application_id: r.application_id,
        type: 'premature', principal: num(r.total_principal), penalty: num(r.penalty_amount),
        net_payment: num(r.net_payment_amount), broken_interest: num(r.broken_period_interest),
        requested_date: d(r.created_at), redemption_date: d(r.redemption_date),
        reason: r.reason ?? null, approval_request_id: null, utr: r.utr ?? null,
        status: mapRedemptionStatus(r.status), created_by_user_id: r.created_by_user_id ?? null,
      };
    });

    // ── incentive accruals (staff + agent + referrer, normalised) ────────
    // referrers first (so referrer accruals have a payee row)
    const refByNorm = new Map<string, number>();
    let refSeq = 1;
    for (const inc of oldIncentives) {
      if (inc._payee_type === 'referrer' && inc._payee_ref && !refByNorm.has(inc._payee_ref)) {
        const id = refSeq++;
        refByNorm.set(inc._payee_ref, id);
        try {
          await insertRow(tx, 'referrers', {
            id, normalized_name: inc._payee_ref,
            display_name: inc.referrer_name_display ?? inc._payee_ref,
            eligibility_status: 'Approved',
          });
        } catch { /* dup name → ignore */ }
      }
    }
    await load('incentive_accruals', oldIncentives, (r) => {
      let payeeId: any = null;
      if (r._payee_type === 'referrer') payeeId = refByNorm.get(r._payee_ref);
      else payeeId = r._payee_ref;
      if (!payeeId || !r.application_id) return null;
      const rate = num(r.applied_pct ?? r.rate_pct);
      return {
        application_id: r.application_id, payee_type: r._payee_type, payee_id: payeeId,
        matrix_cell: null, rate_mode: 'pct', rate_value: rate,
        amount: num(r.amount), accrual_date: d(r.accrual_date ?? r.accrued_date ?? r.created_at) ?? anchor,
        paid_at: r.paid_at ?? null,
      };
    });

    // ── money reconciliation on the loaded side ─────────────────────────
    const aumR = await tx.query<{ s: string }>(
      `SELECT COALESCE(SUM(total_amount),0) AS s FROM applications WHERE status='Active'`
    );
    report.aum.activeLoaded = num(aumR.rows[0]?.s);
  };

  if (dryRun) {
    // Load inside a transaction, then throw to roll everything back.
    try {
      await target.withTx(async (tx) => {
        await run(tx);
        throw new RollbackSignal();
      });
    } catch (e) {
      if (!(e instanceof RollbackSignal)) throw e;
    }
  } else {
    await target.withTx(run);
  }

  return report;
}

class RollbackSignal extends Error {}

// ── status coercions (old free-text → new vocabulary) ──────────────────
function mapAppStatus(s: string): string {
  const v = (s ?? '').trim();
  if (v === 'PendingCollection') return 'PendingFundVerification';
  const known = new Set([
    'Draft', 'PendingApproval', 'PendingFundVerification', 'PendingEsign',
    'PendingAllotment', 'Active', 'Matured', 'Redeemed', 'RolledOver',
    'PrematureWithdrawn', 'Transferred', 'Cancelled', 'Rejected',
  ]);
  return known.has(v) ? v : 'Active';
}

function mapSeriesStatus(s: string): string {
  const v = (s ?? '').trim();
  if (v === 'Allotted' || v === 'Active') return 'Allotted';
  const known = new Set(['Open', 'Closing', 'Closed', 'Allotted', 'Withdrawn']);
  return known.has(v) ? v : 'Open';
}

function mapRedemptionStatus(s: string): string {
  const v = (s ?? '').trim();
  const map: Record<string, string> = {
    PendingApproval: 'Requested', Approved: 'Approved', Rejected: 'Rejected',
    NEFTGenerated: 'Paid',
  };
  return map[v] ?? 'Requested';
}
