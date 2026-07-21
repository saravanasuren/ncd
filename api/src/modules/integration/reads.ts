/**
 * LockerHub façade — customer READS (L1/L2/L3/L7/L8/L9/L10 + SOA + ledger +
 * NCD-match + locker-deposit status). Response shapes byte-compatible with the
 * legacy routes/integration/customer-reads.js; the /ncd/* pair mirrors what
 * the LockerHub consumer reads (its wealthNcdMatch/_pollLockerDepositApprovals).
 */
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { renderPdf, letterhead } from '../../lib/pdf.js';
import {
  customerFacingStatus, iso, lockerhubScopedCustomersByPhone,
  normalisePhone, pad, phoneMatchSql, statementCutoff,
} from './shared.js';

export const customerReadsRouter = Router();

// ─── L1 · Customer lookup by phone (legacy path) ─────────────────────────
customerReadsRouter.get('/customer-by-phone/:phone', asyncHandler(async (req, res) => {
  const phone = normalisePhone(req.params.phone);
  if (phone.length !== 10) return res.status(400).json({ error: 'phone must be at least 10 digits' });
  const rows = await lockerhubScopedCustomersByPhone(getDb(), phone);
  if (rows.length === 0) return res.json({ found: false });
  const c = rows[0]!;
  res.json({
    found: true,
    customer_id: Number(c.id),
    customer_code: c.customer_code,
    name: c.full_name,
    kyc_status: c.kyc_status || 'Pending',
    email: c.email || null,
    // 'verified' = Wealth has signed off on the customer record.
    verified: c.creation_status === 'Approved',
    match_count: rows.length,
  });
}));

// ─── L1.B · Multi-customer phone lookup ──────────────────────────────────
customerReadsRouter.get('/customers-by-phone/:phone', asyncHandler(async (req, res) => {
  const phone = normalisePhone(req.params.phone);
  if (phone.length !== 10) return res.status(400).json({ error: 'phone must be at least 10 digits' });
  const rows = await lockerhubScopedCustomersByPhone(getDb(), phone);
  res.json({
    found: rows.length > 0,
    count: rows.length,
    customers: rows.map((c) => ({
      customer_id: Number(c.id),
      customer_code: c.customer_code,
      name: c.full_name,
      kyc_status: c.kyc_status || 'Pending',
      email: c.email || null,
      verified: c.creation_status === 'Approved',
    })),
  });
}));

// ─── L2 · Customer NCD holdings ──────────────────────────────────────────
customerReadsRouter.get('/customers/:id/holdings', asyncHandler(async (req, res) => {
  const db = getDb();
  const customerId = parseInt(String(req.params.id), 10);

  const c = (await db.query<{ id: string; customer_code: string; full_name: string }>(
    'SELECT id, customer_code, full_name FROM customers WHERE id = $1 AND is_active = TRUE', [customerId]
  )).rows[0];
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  const nom = (await db.query<{ full_name: string }>(
    'SELECT full_name FROM nominees WHERE customer_id = $1 ORDER BY id LIMIT 1', [customerId]
  )).rows[0];
  const nomineeName = nom?.full_name ?? null;

  // Payout account: ncd keeps bank accounts in customer_bank_accounts (no flat
  // customer columns) — mask the active account.
  const acct = (await db.query<{ account_number: string }>(
    'SELECT account_number FROM customer_bank_accounts WHERE customer_id = $1 AND is_active = TRUE LIMIT 1', [customerId]
  )).rows[0];
  const payoutAcct = acct ? String(acct.account_number) : '';
  const payoutAcctMasked = payoutAcct.length >= 4 ? 'XXXX' + payoutAcct.slice(-4) : null;

  // All live applications (every status except terminal-removed), LEFT JOIN
  // lines so an application without lines still surfaces as one holding.
  const { rows: lines } = await db.query<Record<string, unknown>>(
    `SELECT al.id AS line_id, al.amount, al.coupon_rate_pct, al.payout_frequency,
            al.tenure_months, al.maturity_date AS line_maturity_date, al.status AS line_status,
            a.id AS application_id, a.application_no, a.status AS application_status,
            a.total_amount AS app_total_amount, a.allotment_date, a.maturity_date AS app_maturity_date,
            a.interest_start_date, a.date_money_received, a.is_locker_deposit,
            s.code AS series_code, s.name AS series_name,
            sch.code AS scheme_code, sch.name AS scheme_name
       FROM applications a
       LEFT JOIN application_lines al ON al.application_id = a.id
       LEFT JOIN series s             ON s.id = a.series_id
       LEFT JOIN schemes sch          ON sch.id = al.scheme_id
      WHERE a.customer_id = $1
        AND a.status NOT IN ('Redeemed','Cancelled','Rejected','Transferred')
      ORDER BY a.id, al.id`,
    [customerId]
  );

  const today = new Date().toISOString().slice(0, 10);
  const holdings: Array<Record<string, unknown>> = [];
  for (const l of lines) {
    let next: { due_date: unknown; net_amount: unknown } | null = null;
    let paid = 0, rem = 0, proj = 0;
    if (l.line_id != null) {
      next = (await db.query<{ due_date: string; net_amount: string }>(
        `SELECT due_date, net_amount FROM disbursement_schedule
          WHERE line_id = $1 AND status = 'Scheduled' ORDER BY due_date ASC LIMIT 1`,
        [l.line_id]
      )).rows[0] ?? null;
      const agg = (await db.query<{ paid: string; rem: string; proj: string }>(
        `SELECT COALESCE(SUM(net_amount) FILTER (WHERE status = 'Paid'), 0)::numeric      AS paid,
                COALESCE(SUM(net_amount) FILTER (WHERE status = 'Scheduled'), 0)::numeric AS rem,
                COALESCE(SUM(net_amount), 0)::numeric                                     AS proj
           FROM disbursement_schedule
          WHERE line_id = $1 AND due_type IN ('Interest','BrokenInterest')`,
        [l.line_id]
      )).rows[0]!;
      paid = Number(agg.paid || 0); rem = Number(agg.rem || 0); proj = Number(agg.proj || 0);
    }

    const maturityIso = iso(l.line_maturity_date ?? l.app_maturity_date);
    const isMatured = maturityIso
      ? (maturityIso <= today && (l.line_status === 'Active' || l.application_status === 'Active'))
      : false;
    const principal = l.amount != null ? Number(l.amount) : Number(l.app_total_amount || 0);
    const appStatus = l.application_status as string;

    holdings.push({
      application_no: l.application_no,
      line_id: l.line_id != null ? Number(l.line_id) : null,
      series_name: l.series_name ?? null,
      scheme_name: l.scheme_name ?? null,
      principal,
      coupon_rate_pct: l.coupon_rate_pct != null ? Number(l.coupon_rate_pct) : null,
      payout_frequency: l.payout_frequency ?? null,
      interest_start_date: iso(l.interest_start_date ?? l.date_money_received),
      maturity_date: maturityIso,
      status: customerFacingStatus(appStatus, isMatured),
      internal_status: appStatus,
      customer_status: customerFacingStatus(appStatus, isMatured),
      line_status: l.line_status ?? null,
      is_matured: isMatured,
      next_payout_date: next ? iso(next.due_date) : null,
      next_payout_amount: next ? Number(next.net_amount) : null,
      total_interest_paid: paid,
      total_interest_remaining: rem,
      total_interest_projected: proj,
      nominee_name: nomineeName,
      payout_account_masked: payoutAcctMasked,
      is_locker_deposit: Boolean(l.is_locker_deposit),
      // Integration-contract aliases (B5): LockerHub's spec names these
      // `rate` / `nominee` / `next_payout`. Emit them alongside the richer
      // native fields so either reader is satisfied.
      rate: l.coupon_rate_pct != null ? Number(l.coupon_rate_pct) : null,
      nominee: nomineeName,
      next_payout: next ? iso(next.due_date) : null,
    });
  }

  // Totals block — the locker double-count guard (docs/08 §1).
  let ncdPrincipal = 0;
  let lockerDepositViaNcd = 0;
  for (const h of holdings) {
    const p = Number(h.principal || 0);
    ncdPrincipal += p;
    if (h.is_locker_deposit) lockerDepositViaNcd += p;
  }

  res.json({
    customer_id: Number(c.id),
    customer_code: c.customer_code,
    name: c.full_name,
    totals: {
      ncd_principal: Number(ncdPrincipal.toFixed(2)),
      ncd_principal_excluding_locker_deposits: Number((ncdPrincipal - lockerDepositViaNcd).toFixed(2)),
      locker_deposit_via_ncd: Number(lockerDepositViaNcd.toFixed(2)),
    },
    holdings,
  });
}));

// ─── L3 · Active NCD series ──────────────────────────────────────────────
customerReadsRouter.get('/series/active', asyncHandler(async (_req, res) => {
  const db = getDb();
  const { rows: serieses } = await db.query<Record<string, unknown>>(
    `SELECT s.id, s.code, s.name, s.status, s.opened_at
       FROM series s
      WHERE s.status = 'Open'
      ORDER BY s.opened_at DESC NULLS LAST, s.id DESC`
  );

  const out: Array<Record<string, unknown>> = [];
  for (const s of serieses) {
    const { rows: schemes } = await db.query<Record<string, unknown>>(
      `SELECT sch.id, sch.code, sch.name, sch.tenure_months, sch.coupon_rate_pct,
              sch.payout_frequency, sch.min_ticket, sch.multiple_of, sch.face_value
         FROM schemes sch
         JOIN series_schemes ss ON ss.scheme_id = sch.id
        WHERE ss.series_id = $1
        ORDER BY sch.tenure_months ASC, sch.coupon_rate_pct DESC`,
      [s.id]
    );
    const raised = (await db.query<{ amount_raised: string }>(
      `SELECT COALESCE(SUM(al.amount), 0) AS amount_raised
         FROM applications a
         JOIN customers c ON c.id = a.customer_id AND c.is_active = TRUE
         JOIN application_lines al ON al.application_id = a.id
        WHERE a.series_id = $1
          AND a.status IN ('Active','Matured','Redeemed','RolledOver','PendingAllotment')`,
      [s.id]
    )).rows[0]!;

    // Headline scheme = the first (schemes are ordered by coupon_rate_pct DESC),
    // i.e. the "Up to X% p.a." rate the product hub shows.
    const headline = schemes[0];
    out.push({
      series_id: Number(s.id),
      code: s.code,
      name: s.name,
      // ncd's series table has no open/close-date or target columns — expose
      // opened_at as open_date; close_date/target_amount degrade to null/0.
      open_date: iso(s.opened_at),
      close_date: null,
      target_amount: 0,
      amount_raised: Number(raised.amount_raised || 0),
      // Integration-contract fields (B9): LockerHub expects scheme_id /
      // coupon_rate_pct / min_amount FLAT on the series (its product cards read
      // the headline rate). Mirror the headline scheme up; the full per-scheme
      // list stays in `schemes[]` for richer callers.
      scheme_id: headline ? Number(headline.id) : null,
      coupon_rate_pct: headline ? Number(headline.coupon_rate_pct) : null,
      min_amount: headline ? Number(headline.min_ticket || 100000) : null,
      schemes: schemes.map((sc) => ({
        scheme_id: Number(sc.id),
        code: sc.code,
        name: sc.name,
        tenure_months: sc.tenure_months != null ? Number(sc.tenure_months) : null,
        coupon_rate_pct: Number(sc.coupon_rate_pct),
        payout_frequency: sc.payout_frequency,
        min_ticket: Number(sc.min_ticket || 100000),
        min_amount: Number(sc.min_ticket || 100000), // contract alias for min_ticket
        multiple_of: Number(sc.multiple_of || 100000),
        face_value: Number(sc.face_value || 100000),
      })),
    });
  }
  res.json({ series: out });
}));

// ─── L7 · Transactions ledger (record of what happened; cutoff-filtered) ──
interface LedgerRow {
  date: string | null; application_no: string | null; type: string; description: string;
  gross: number; tds: number; net: number; credit: number; reference: string | null;
}

async function ledgerRows(customerId: number, applicationNo?: string): Promise<LedgerRow[]> {
  const db = getDb();
  const cutoff = await statementCutoff(db);

  const appParams: unknown[] = [customerId, cutoff];
  let appFilter = '';
  if (applicationNo) { appParams.push(applicationNo); appFilter = ` AND a.application_no = $${appParams.length}`; }
  const { rows: invs } = await db.query<Record<string, unknown>>(
    `SELECT a.application_no, a.date_money_received,
            COALESCE(a.amount_received, a.total_amount, 0) AS amount,
            a.collection_method, a.collection_reference
       FROM applications a
      WHERE a.customer_id = $1
        AND COALESCE(a.date_money_received, a.allotment_date) IS NOT NULL
        AND COALESCE(a.date_money_received, a.allotment_date) >= $2::date
        ${appFilter}`,
    appParams
  );

  const dsParams: unknown[] = [customerId, cutoff];
  let dsFilter = '';
  if (applicationNo) { dsParams.push(applicationNo); dsFilter = ` AND a.application_no = $${dsParams.length}`; }
  const { rows: payouts } = await db.query<Record<string, unknown>>(
    `SELECT ds.id AS schedule_id, ds.due_date, ds.due_type, ds.gross_amount, ds.tds_amount, ds.net_amount,
            ds.paid_at, ds.utr, a.application_no
       FROM disbursement_schedule ds
       JOIN application_lines al ON al.id = ds.line_id
       JOIN applications a       ON a.id = al.application_id
      WHERE a.customer_id = $1
        AND ds.status = 'Paid'
        AND COALESCE(ds.paid_at, ds.due_date) >= $2::date
        ${dsFilter}
      ORDER BY COALESCE(ds.paid_at, ds.due_date) ASC, ds.id ASC`,
    dsParams
  );

  const txns: LedgerRow[] = [];
  for (const inv of invs) {
    const amt = Number(inv.amount);
    txns.push({
      date: iso(inv.date_money_received),
      application_no: (inv.application_no as string) ?? null,
      type: 'investment',
      description: `Investment received via ${inv.collection_method || 'transfer'}`,
      gross: amt, tds: 0, net: amt, credit: amt,
      reference: (inv.collection_reference as string) || null,
    });
  }
  for (const p of payouts) {
    const gross = Number(p.gross_amount || 0);
    const tds = Number(p.tds_amount || 0);
    const net = Number(p.net_amount || 0);
    const ref = (p.utr as string) || `PAYOUT-${pad(String(p.schedule_id), 6)}`;
    const isInterest = p.due_type !== 'Redemption';
    const desc = p.due_type === 'Redemption' ? 'Principal redemption'
      : p.due_type === 'BrokenInterest' ? 'Broken-period interest payout'
      : 'Monthly interest payout';
    txns.push({
      date: iso(p.paid_at) ?? iso(p.due_date),
      application_no: (p.application_no as string) ?? null,
      type: isInterest ? 'interest' : 'redemption',
      description: desc,
      gross, tds, net, credit: net,
      reference: ref,
    });
  }
  txns.sort((x, y) => {
    const dx = x.date || '0000-00-00';
    const dy = y.date || '0000-00-00';
    return dx === dy ? 0 : dx < dy ? -1 : 1;
  });
  return txns;
}

customerReadsRouter.get('/customers/:id/transactions', asyncHandler(async (req, res) => {
  const customerId = parseInt(String(req.params.id), 10);
  const { application_no, from, to } = (req.query ?? {}) as Record<string, string | undefined>;

  const c = (await getDb().query<{ customer_code: string }>(
    'SELECT customer_code FROM customers WHERE id = $1 AND is_active = TRUE', [customerId]
  )).rows[0];
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  const txns = await ledgerRows(customerId, application_no);
  const inRange = (t: LedgerRow) => {
    if (!t.date) return false;
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    return true;
  };
  res.json({ customer_code: c.customer_code, transactions: (from || to) ? txns.filter(inRange) : txns });
}));

// ─── L8.B1 · Documents list ──────────────────────────────────────────────
customerReadsRouter.get('/customers/:id/documents', asyncHandler(async (req, res) => {
  const db = getDb();
  const customerId = parseInt(String(req.params.id), 10);
  const c = (await db.query<{ id: string; customer_code: string }>(
    'SELECT id, customer_code FROM customers WHERE id = $1 AND is_active = TRUE', [customerId]
  )).rows[0];
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  const { rows: apps } = await db.query<Record<string, unknown>>(
    `SELECT a.id, a.application_no, a.status, a.allotment_date,
            s.code AS series_code, s.name AS series_name
       FROM applications a JOIN series s ON s.id = a.series_id
      WHERE a.customer_id = $1 ORDER BY a.id`,
    [customerId]
  );

  const docs: Array<Record<string, unknown>> = [];
  for (const a of apps) {
    const allotmentIso = iso(a.allotment_date);
    // Bond/allotment certificate only exists once the series has been allotted.
    if (allotmentIso && ['Active', 'Matured', 'Redeemed', 'RolledOver'].includes(a.status as string)) {
      docs.push({
        doc_id: `BOND-${a.id}`,
        type: 'certificate',
        application_no: a.application_no,
        title: `NCD Certificate — ${a.series_code || a.series_name}`,
        financial_year: null,
        issued_date: allotmentIso,
      });
    }
    if (['PendingFundVerification', 'PendingEsign', 'PendingAllotment', 'Active', 'Matured', 'Redeemed', 'RolledOver'].includes(a.status as string)) {
      docs.push({
        doc_id: `AGREEMENT-${a.id}`,
        type: 'agreement',
        application_no: a.application_no,
        title: `NCD Application & Agreement — ${a.application_no}`,
        financial_year: null,
        issued_date: allotmentIso,
      });
    }
  }
  docs.push({
    doc_id: `STMT-${Number(c.id)}`,
    type: 'statement',
    application_no: null,
    title: 'Statement of Account',
    financial_year: null,
    issued_date: new Date().toISOString().slice(0, 10),
  });

  res.json({ documents: docs });
}));

// ─── L8.B2 · Document download (PDF stream; ownership enforced) ──────────
customerReadsRouter.get('/customers/:id/documents/:docId', asyncHandler(async (req, res) => {
  const db = getDb();
  const customerId = parseInt(String(req.params.id), 10);
  const docId = String(req.params.docId || '');
  const m = docId.match(/^([A-Z]+)-(\d+)$/);
  if (!m) return res.status(400).json({ error: 'invalid doc_id' });
  const kind = m[1]!;
  const entityId = parseInt(m[2]!, 10);

  if (kind === 'BOND' || kind === 'AGREEMENT') {
    const a = (await db.query<Record<string, unknown>>(
      `SELECT a.id, a.customer_id, a.application_no, a.status, a.total_amount, a.allotment_date, a.maturity_date,
              c.full_name, c.customer_code, s.code AS series_code, s.name AS series_name
         FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
        WHERE a.id = $1`,
      [entityId]
    )).rows[0];
    if (!a || Number(a.customer_id) !== customerId) return res.status(404).json({ error: 'Document not found' });

    const lines = (await db.query<Record<string, unknown>>(
      `SELECT al.amount, al.coupon_rate_pct, al.tenure_months, al.payout_frequency, sch.name AS scheme_name
         FROM application_lines al LEFT JOIN schemes sch ON sch.id = al.scheme_id
        WHERE al.application_id = $1 ORDER BY al.id`,
      [entityId]
    )).rows;

    const buf = await renderPdf((doc) => {
      letterhead(
        doc,
        kind === 'BOND' ? 'Non-Convertible Debenture Certificate' : 'NCD Application & Agreement',
        `${a.full_name} · ${a.customer_code}`
      );
      doc.fontSize(10).font('Helvetica');
      doc.text(`Application No: ${a.application_no}`);
      doc.text(`Series: ${a.series_name} (${a.series_code})`);
      doc.text(`Principal: ₹${Number(a.total_amount).toFixed(2)}`);
      if (a.allotment_date) doc.text(`Allotment date: ${iso(a.allotment_date)}`);
      if (a.maturity_date) doc.text(`Maturity date: ${iso(a.maturity_date)}`);
      doc.moveDown(0.6).font('Helvetica-Bold').text('Schemes').font('Helvetica').fontSize(9);
      for (const l of lines) {
        doc.text(`${l.scheme_name ?? '—'}   ₹${Number(l.amount).toFixed(2)}   ${Number(l.coupon_rate_pct)}%   ${l.tenure_months}m   ${l.payout_frequency}`);
      }
      if (!lines.length) doc.fillColor('#6b7380').text('None');
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${docId}.pdf"`);
    return res.send(buf);
  }

  if (kind === 'STMT') {
    if (entityId !== customerId) return res.status(404).json({ error: 'Document not found' });
    const { soaPdf } = await import('../reports/documents.js');
    const buf = await soaPdf(db, customerId, true); // customer-facing cutoff applied
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${docId}.pdf"`);
    return res.send(buf);
  }

  return res.status(400).json({ error: 'unsupported doc_id kind' });
}));

// ─── L9 · Service-request status ─────────────────────────────────────────
// Legacy read lockerhub_service_requests; ncd sources the same lifecycle from
// its native queues: redemptions (source='lockerhub') + investor_leads
// (LockerHub sources). Same normalised vocabulary:
// pending | approved | rejected | completed | cancelled.
customerReadsRouter.get('/customers/:id/requests', asyncHandler(async (req, res) => {
  const db = getDb();
  const customerId = parseInt(String(req.params.id), 10);
  const filterStatus = req.query?.status ? String(req.query.status).toLowerCase() : null;
  const c = (await db.query<{ id: string }>(
    'SELECT id FROM customers WHERE id = $1 AND is_active = TRUE', [customerId]
  )).rows[0];
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  const { rows: redemptions } = await db.query<Record<string, unknown>>(
    `SELECT r.id, r.status, r.reason, r.created_at, a.application_no,
            (SELECT ar.status FROM approval_requests ar WHERE ar.id = r.approval_request_id) AS approval_status
       FROM redemptions r JOIN applications a ON a.id = r.application_id
      WHERE a.customer_id = $1 AND r.source = 'lockerhub'
      ORDER BY r.created_at DESC LIMIT 200`,
    [customerId]
  );
  const { rows: leads } = await db.query<Record<string, unknown>>(
    `SELECT l.id, l.status, l.expected_amount, l.notes, l.created_at, l.updated_at
       FROM investor_leads l
      WHERE l.source IN ('LockerHub Web','LockerHub Mobile')
        AND (l.converted_customer_id = $1
          OR ${phoneMatchSql('l.phone')} =
             (SELECT ${phoneMatchSql('phone')} FROM customers WHERE id = $1))
      ORDER BY l.created_at DESC LIMIT 200`,
    [customerId]
  );

  const mapRedemption = (s: string, appr: string | null): string => {
    if (s === 'Rejected') return 'rejected';
    if (s === 'Cancelled') return 'cancelled';
    if (s === 'Paid' || s === 'Closed' || appr === 'Approved') return 'completed';
    if (appr === 'Rejected') return 'rejected';
    if (appr === 'Pending') return 'approved'; // sitting in the approval queue
    return 'pending';
  };
  const mapLead = (s: string): string => {
    if (s === 'Converted') return 'completed';
    if (s === 'Dropped' || s === 'Lost' || s === 'Rejected') return 'rejected';
    return 'pending';
  };
  const refYear = (d: unknown) => (iso(d) ?? new Date().toISOString()).slice(0, 4);

  const out = [
    ...redemptions.map((r) => ({
      reference_id: `LH-RDM-${refYear(r.created_at)}-${pad(String(r.id), 6)}`,
      type: 'redemption',
      application_no: (r.application_no as string) || null,
      series_id: null,
      scheme_id: null,
      requested_amount: null,
      status: mapRedemption(String(r.status), (r.approval_status as string) ?? null),
      created_at: r.created_at,
      updated_at: r.created_at,
      remarks: (r.reason as string) || '',
    })),
    ...leads.map((l) => ({
      reference_id: `LEAD-${refYear(l.created_at).slice(0, 4)}${(iso(l.created_at) ?? '').slice(5, 7)}-${pad(String(l.id), 5)}`,
      type: 'subscription',
      application_no: null,
      series_id: null,
      scheme_id: null,
      requested_amount: l.expected_amount != null ? Number(l.expected_amount) : null,
      status: mapLead(String(l.status)),
      created_at: l.created_at,
      updated_at: l.updated_at ?? l.created_at,
      remarks: (l.notes as string) || '',
    })),
  ]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .filter((r) => !filterStatus || r.status === filterStatus);

  res.json({ requests: out });
}));

// ─── Customer-facing direct downloads: SOA PDF + ledger CSV ──────────────
customerReadsRouter.get('/customers/:id/soa.pdf', asyncHandler(async (req, res) => {
  const db = getDb();
  const customerId = parseInt(String(req.params.id), 10);
  const c = (await db.query<{ customer_code: string }>(
    'SELECT customer_code FROM customers WHERE id = $1 AND is_active = TRUE', [customerId]
  )).rows[0];
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  const { soaPdf } = await import('../reports/documents.js');
  const buf = await soaPdf(db, customerId, true);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="SOA-${c.customer_code}.pdf"`);
  res.send(buf);
}));

customerReadsRouter.get('/customers/:id/ledger.csv', asyncHandler(async (req, res) => {
  const customerId = parseInt(String(req.params.id), 10);
  const c = (await getDb().query<{ customer_code: string }>(
    'SELECT customer_code FROM customers WHERE id = $1 AND is_active = TRUE', [customerId]
  )).rows[0];
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  const rows = await ledgerRows(customerId);
  const csvCell = (v: unknown): string => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Date', 'Application No', 'Type', 'Description', 'Gross (₹)', 'TDS (₹)', 'Net (₹)', 'Reference'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const typeLabel = r.type === 'investment' ? 'Investment' : r.type === 'interest' ? 'Interest' : 'Redemption';
    lines.push([
      r.date ?? '', r.application_no ?? '', typeLabel, r.description,
      r.gross.toFixed(2), r.tds.toFixed(2), r.net.toFixed(2), r.reference ?? '',
    ].map(csvCell).join(','));
  }
  const csv = lines.join('\n') + '\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Ledger-${c.customer_code}.csv"`);
  res.send(csv);
}));

// ─── L10 · NCD AUM stats (LockerHub dashboard tiles) ─────────────────────
customerReadsRouter.get('/stats/ncd-aum', asyncHandler(async (req, res) => {
  const db = getDb();
  const asOfRaw = String(req.query?.as_of ?? '');
  // Explicit as_of → bound by that date. Absent (LockerHub's usual call) → NO
  // upper bound: snapshot "now". Bounding a default "today" by a JS-computed
  // date races PG's now() across the UTC midnight boundary (brand-new rows land
  // a day ahead of the JS date and vanish from the count).
  const asOf: string | null = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : null;
  const TERMINAL = ['Redeemed', 'Matured', 'RolledOver', 'PrematureWithdrawn', 'Transferred'];
  // ncd has no application_date column — created_at::date is the equivalent.
  const dateFilter = asOf ? 'WHERE a.created_at::date <= $2::date' : '';

  const g = (await db.query<Record<string, unknown>>(
    `SELECT
       ROUND(COALESCE(SUM(a.total_amount),0)/1e7, 2) AS total_issued_cr,
       ROUND(COALESCE(SUM(a.total_amount) FILTER (WHERE a.status = ANY($1::text[])),0)/1e7, 2) AS total_redeemed_cr,
       ROUND(COALESCE(SUM(a.total_amount) FILTER (WHERE a.status <> ALL($1::text[])),0)/1e7, 2) AS total_outstanding_cr,
       COALESCE(SUM(a.total_amount) FILTER (WHERE a.status <> ALL($1::text[])),0)::numeric AS total_outstanding_abs,
       COUNT(*)::int                                             AS apps_total,
       COUNT(*) FILTER (WHERE a.status <> ALL($1::text[]))::int  AS apps_active,
       COUNT(*) FILTER (WHERE a.status =  ANY($1::text[]))::int  AS apps_redeemed
       FROM applications a
       JOIN customers c ON c.id = a.customer_id AND c.is_active = TRUE
      ${dateFilter}`,
    asOf ? [TERMINAL, asOf] : [TERMINAL]
  )).rows[0]!;

  const customersTotal = (await db.query<{ customers_total: number }>(
    `SELECT COUNT(DISTINCT a.customer_id)::int AS customers_total
       FROM applications a JOIN customers c ON c.id = a.customer_id AND c.is_active = TRUE`
  )).rows[0]!.customers_total;

  const { rows: seriesBreakdown } = await db.query<Record<string, unknown>>(
    `SELECT sr.id, sr.code, sr.name, sr.status,
            ROUND(COALESCE(SUM(a.total_amount),0)/1e7, 2) AS issued_cr,
            ROUND(COALESCE(SUM(a.total_amount) FILTER (WHERE a.status = ANY($1::text[])),0)/1e7, 2) AS redeemed_cr,
            ROUND(COALESCE(SUM(a.total_amount) FILTER (WHERE a.status <> ALL($1::text[])),0)/1e7, 2) AS outstanding_cr,
            COUNT(a.id)::int AS apps_count
       FROM series sr
       LEFT JOIN applications a ON a.series_id = sr.id${asOf ? ' AND a.created_at::date <= $2::date' : ''}
       LEFT JOIN customers c ON c.id = a.customer_id AND c.is_active = TRUE
      WHERE a.id IS NULL OR c.id IS NOT NULL
      GROUP BY sr.id, sr.code, sr.name, sr.status
      ORDER BY sr.id`,
    asOf ? [TERMINAL, asOf] : [TERMINAL]
  );

  res.json({
    as_of: asOf ?? new Date().toISOString().slice(0, 10),
    total_issued_cr: Number(g.total_issued_cr),
    total_redeemed_cr: Number(g.total_redeemed_cr),
    total_outstanding_cr: Number(g.total_outstanding_cr),
    // Integration-contract aliases (B16): LockerHub's tile reads `aum` (absolute
    // rupees) and `investors`. total_outstanding_cr is the crore form of the same.
    aum: Number(Number(g.total_outstanding_abs).toFixed(2)),
    investors: Number(customersTotal),
    apps_total: Number(g.apps_total),
    apps_active: Number(g.apps_active),
    apps_redeemed: Number(g.apps_redeemed),
    customers_total: Number(customersTotal),
    series_breakdown: seriesBreakdown.map((s) => ({
      series_id: Number(s.id),
      series_code: s.code,
      series_name: s.name,
      series_status: s.status,
      issued_cr: Number(s.issued_cr),
      redeemed_cr: Number(s.redeemed_cr),
      outstanding_cr: Number(s.outstanding_cr),
      apps_count: Number(s.apps_count),
    })),
  });
}));

// ─── W1 · Match an existing Active NCD by PAN (+ exact amount) ───────────
// Shape mirrors what LockerHub's wealthNcdMatch consumer reads:
// { found, candidates: [{ ncd_id, customer_code, holder_name, principal,
//   issue_date, status, already_linked_to }] }.
customerReadsRouter.get('/ncd/match', asyncHandler(async (req, res) => {
  const pan = String(req.query?.pan ?? '').toUpperCase().replace(/\s+/g, '');
  const amountRaw = req.query?.amount != null ? Number(req.query.amount) : null;
  if (!pan || pan.length !== 10) return res.status(400).json({ error: 'pan required (10 characters)' });

  const params: unknown[] = [pan];
  let amountFilter = '';
  if (amountRaw != null && Number.isFinite(amountRaw) && amountRaw > 0) {
    params.push(Math.round(amountRaw));
    amountFilter = ` AND ROUND(a.total_amount) = $${params.length}`;
  }
  const { rows } = await getDb().query<Record<string, unknown>>(
    `SELECT a.application_no, a.total_amount, a.allotment_date, a.status,
            a.is_locker_deposit, a.lockerhub_intent_no, c.customer_code, c.full_name
       FROM applications a JOIN customers c ON c.id = a.customer_id
      WHERE UPPER(TRIM(COALESCE(c.pan,''))) = $1
        AND c.is_active = TRUE
        AND a.status = 'Active'
        ${amountFilter}
      ORDER BY a.id ASC`,
    params
  );
  const candidates = rows.map((r) => ({
    ncd_id: String(r.application_no),
    customer_code: String(r.customer_code || ''),
    holder_name: String(r.full_name || ''),
    principal: Number(r.total_amount || 0),
    amount: Number(r.total_amount || 0), // contract alias for principal
    issue_date: iso(r.allotment_date) ?? '',
    status: String(r.status),
    already_linked_to: r.is_locker_deposit === true ? String(r.lockerhub_intent_no || 'linked') : null,
  }));
  // Integration-contract (B17) reads the top-level flat form { found, ncd_id,
  // holder_name, amount }; the richer `candidates[]` stays for the live consumer.
  const top = candidates[0];
  res.json({
    found: candidates.length > 0,
    ncd_id: top ? top.ncd_id : null,
    holder_name: top ? top.holder_name : null,
    amount: top ? top.amount : null,
    candidates,
  });
}));

// ─── W4 · Locker-deposit approval status ─────────────────────────────────
// LockerHub polls this until the deposit-as-NCD is 'registered' or 'rejected'.
// Consumer reads: approval_status, ncd_id, rejected_reason.
customerReadsRouter.get('/ncd/locker-deposit-status', asyncHandler(async (req, res) => {
  const ref = String(req.query?.deposit_reference ?? '').trim();
  if (!ref) return res.status(400).json({ error: 'deposit_reference required' });

  const db = getDb();
  const app = (await db.query<Record<string, unknown>>(
    `SELECT id, application_no, status FROM applications WHERE lockerhub_intent_no = $1 LIMIT 1`,
    [ref]
  )).rows[0];
  if (!app) return res.status(404).json({ error: 'Deposit not found' });

  const internal = String(app.status);
  let approvalStatus: string;
  let rejectedReason: string | null = null;
  if (internal === 'Rejected' || internal === 'Cancelled') {
    approvalStatus = 'rejected';
    const reason = (await db.query<{ reason: string | null }>(
      `SELECT aa.reason
         FROM approval_requests ar
         JOIN approval_actions aa ON aa.approval_request_id = ar.id AND aa.action = 'reject'
        WHERE ar.entity_type = 'applications' AND ar.entity_id = $1
        ORDER BY aa.id DESC LIMIT 1`,
      [String(app.id)]
    )).rows[0];
    rejectedReason = reason?.reason ?? null;
  } else if (internal === 'PendingApproval' || internal === 'PendingActivation') {
    approvalStatus = 'pending_approval';
  } else {
    // Approved out of the LockerHub queue (PendingAllotment/Active/…): registered.
    approvalStatus = 'registered';
  }

  res.json({
    found: true,
    deposit_reference: ref,
    ncd_id: String(app.application_no),
    approval_status: approvalStatus,
    rejected_reason: rejectedReason,
    status: internal,
    customer_status: customerFacingStatus(internal, false),
  });
}));
