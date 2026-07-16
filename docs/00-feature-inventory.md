# 00 — Feature Inventory (parity checklist)

Everything the current app does that the new app must also do. Derived from
`WEALTH_COMPLETE_HANDOVER.md` (2026-07-16) + owner's brief. **The build is complete
only when every unchecked box is ticked.** Items marked ⚙ are config-driven (see
doc 07). Items marked 🔌 have an external contract that must not change (doc 08).

## 1. Leads (CRM)

- [ ] Create / edit / list investor leads (name, phone, place, category, source ⚙,
      referred-by free text, interested scheme, expected amount, follow-up date,
      status ⚙, notes)
- [ ] Lead notes / follow-up history
- [ ] Per-creator visibility (staff/agent see own leads; NCD Manager & above see all)
- [ ] Duplicate-phone detection with "customer already exists / request handover" flow
- [ ] Convert lead → customer (requires confirmed amount + confirmed series)
- [ ] Leads arriving from LockerHub/DhanamFin app 🔌 (source tagged, deduped on
      lockerhub application no)
- [ ] Lead KPI funnel on dashboard (drill-down)

## 2. Customers & KYC

- [ ] Customer enrolment (guided multi-step wizard) with draft/resume
- [ ] Customer codes `DHN…` ⚙ (format configurable)
- [ ] Search across name / PAN / phone / code / email
- [ ] Joint holders (up to 2 ⚙), nominees (with share %), demat details
- [ ] Multiple bank accounts per customer; exactly one active; add with penny-drop
      verification 🔌 (Decentro BAV v3) incl. surfacing failure reason + error code;
      IFSC auto-lookup; dedup guard
- [ ] KYC: PAN verify, DigiLocker/Aadhaar flows 🔌, manual verify/reject with docs
      upload; KYC docs list incl. those mirrored from DhanamFin app 🔌
- [ ] Customer correction workflow (field-level diff, maker-checker approved)
- [ ] Profile-change requests from portal/LockerHub 🔌 (approve/reject)
- [ ] Customer handover / reassignment (request → designated approver → transfer
      ownership; one pending per customer; email both parties)
- [ ] Deactivate / reactivate customer; deceased flag + NCD transformation (nominee
      inheritance) workflow
- [ ] PAN masking `XXXXX####X`, phone masking in UI

## 3. Products (Series / Schemes)

- [ ] Schemes CRUD ⚙ (tenure, frequency, coupon rate, face value, min ticket,
      multiple-of, commission rule, TDS rule)
- [ ] Series CRUD ⚙ (monthly batch, e.g. "NCD 27"), series↔scheme links,
      per-series face value ⚙
- [ ] Series lifecycle: Open → Closing → Closed / Withdrawn; lock on allotment
- [ ] Launch-series flow; ISIN set after the fact
- [ ] TDS rules ⚙ (Standard % / 15G / 15H / custom / LDC with validity window)
- [ ] Holidays calendar ⚙; company profile singleton (legal names, TAN + former-name
      flag, signatory, default banks) ⚙
- [ ] Banks master ⚙ (collection + disbursement accounts)

## 4. Applications & Allotment

- [ ] Create application (multi-scheme lines), numbering `APP-YYYY-NNNNNN` ⚙
- [ ] Clubbing: append lines to an in-flight application in the same series
- [ ] Lifecycle: PendingApproval → PendingCollection → PendingEsign →
      PendingAllotment → Active → (Matured / Redeemed / RolledOver / Transferred),
      enforced by a state machine with legal-transition assertions
- [ ] Confirm collection (amount received, date, method ⚙, reference) — interest
      accrues from receipt date
- [ ] Required receipt/cheque photo upload at creation; approver views before approval
- [ ] Per-application interest-payout bank account (default = customer's active
      account; changeable on active investments, re-snapshots only future unpaid rows)
- [ ] eSign via Digio 🔌 (webhook + poller + manual mark-eSigned fallback)
- [ ] Batch allotment per series (maker-checker): allot all pending apps → Active,
      materialise schedules, accrue commission, lock series; revert-allotment
      (Super Admin/Admin, blocked once real money moved)
- [ ] LockerHub-funded investments 🔌: land PendingApproval, customer sees "Active",
      one approval moves them into the eSign→allotment pipeline; sub-minimum flag
- [ ] Application PDFs: application form (overlay on frozen template), allotment
      letter, bond certificate (auto serials ⚙), acknowledgment (+ WhatsApp send 🔌)

## 5. Interest engine & disbursement schedule

- [ ] Option-(b) interest math — **formulas locked, see doc 02 §6**
- [ ] Materialise `disbursement_schedule` at allotment: Interest / BrokenInterest /
      Redemption / Premature rows; TDS + payee bank snapshotted per row
- [ ] Payout day-of-month ⚙ (today: 28th); day-count basis ⚙ (today: /365)
- [ ] Schedule visible per application (grouped by month, overdue highlighted)
- [ ] ALM tiles: net due this month, overdue, paid this FY

## 6. Money-out: payouts, redemptions, transfers

- [ ] NEFT interest batches: preview by date → maker submits → checker approves →
      Federal-Bank-format XLSX download (exact 12-column layout preserved) →
      mark rows paid/failed → reconcile; bank-statement upload flips Scheduled→Paid
      with UTR + value date (authoritative Paid source)
- [ ] Admin-only manual mark-paid with reason (audit-logged)
- [ ] Premature redemption: per-application, 2-level approval (maker → CXO tier),
      penalty ⚙, **Net Payment = Principal − Penalty** (broken interest paid
      separately next cycle), approver sets/confirms redemption date (recomputes
      broken interest to that date), verify checkbox, redemption NEFT sheet + UTR
      tracking, redemption report download
- [ ] **Fix the known bug from the old app:** approval must reliably close the
      application (Redeemed / outstanding reduced) — regression-test this
- [ ] Maturity redemption at tenure end
- [ ] Rollover, holder transfer (`ncd_transfers`, lineage), NCD transformation on
      death (nominee bank capture → new holder)
- [ ] Statement ingestion: bank statements + SBI statements, auto-match + manual
      match/ignore

## 7. Commissions & incentives (staff, agent, referrer)

- [ ] Incentive matrix ⚙ (4 cells, rates in settings — see doc 02 §6):
      brand-new-customer × referrer-named decides staff % vs referrer %
- [ ] `customer_was_new_at_creation` stamped at insert, never re-derived
- [ ] Agent commission eligibility (rate ⚙ ≤ cap ⚙, payout mode ⚙, bank details),
      CXO-approved; revoke
- [ ] Referrer (free-text name) incentives: grouped by normalised name, eligibility
      request/approve/revoke, retroactive backfill on approval
- [ ] Accruals at allotment/eSign; **paid accrual rows never overwritten**
- [ ] Payout ledger with partial payments + running balance (owed = accrued − paid)
- [ ] Commission/incentive NEFT batches (payroll payouts)
- [ ] Performance pages: agent-wise + staff(executive)-wise production, clickable →
      owed-since-last-payout drill-down with inline payout
- [ ] "My earnings" page for agents/staff (own accruals + payouts)
- [ ] Staff-incentive PDF statement

## 8. Approvals (maker-checker engine)

- [ ] Generic approval engine: typed requests, 2-level and 4-level chains ⚙,
      per-type checker roles ⚙, `onFinalApprove`/`onReject` callbacks in the same TX
- [ ] **No self-approval, ever** (locked decision — applies to all roles incl.
      NCD Manager and Super Admin; two distinct humans per approval)
- [ ] Types: subscription, allotment batch, redemption, premature redemption,
      commission/incentive/referrer eligibility, customer correction, customer
      reassignment, NCD transfer, NCD transformation, interest batch, payroll batch,
      agent registration
- [ ] One Approvals page with per-type tabs, badges, diff rendering, explicit
      approve/reject wording, re-confirm modals for money actions

## 9. Dashboards & reports

- [ ] CXO/Admin dashboard ("NCD Portfolio"): KPI tiles, universal search, today's
      book (additions by source, deletions), monthly redemptions (clickable rows),
      cost-of-funds rate mix, series register (rate ranges), district/city
      distribution — every number drills down in-page (spec: doc 06)
- [ ] Segregated data views: **customer-wise, district-wise, agent-wise, staff-wise**
      (doc 06 §4)
- [ ] 9-tab Excel export in the owner's pivot format with filters applied (doc 06 §3)
- [ ] SOA per customer (PDF), Interest & TDS Register XLSX (17-col filing layout),
      TDS report (26Q support; Form 16A intentionally NOT issued — point to TRACES),
      series-wise rollup XLSX, full DB dump XLSX
- [ ] Statement display cutoff ⚙ for customer-facing lists (aggregates always full)

## 10. Users, auth & portal

- [ ] The 8 roles + permission matrix of doc 03; user CRUD (Admin), branch
      assignment, Branch Manager ↔ multiple branches, reports-to (manager) field
- [ ] Login (email+password), forgot/reset via email OTP, change password,
      seed-admin bootstrap
- [ ] JWT access + refresh in HttpOnly cookies, CSRF header on mutations
- [ ] Customer portal: OTP login (rate-limited, masked destinations), holdings,
      payouts (display cutoff ⚙), documents (SOA/bond/allotment PDFs), service
      requests, NCD transfer self-service
- [ ] Agent self-signup via DhanamFin app 🔌 (registration approval queue,
      email-check routing, webview session handoff)
- [ ] Audit log (before/after JSONB) on every state change; audit browser for admins

## 11. Integrations (all preserved 🔌 — doc 08)

- [ ] LockerHub customer reads L1–L10, writes, customer auth LA1–LA4, agent auth,
      KYC mirror — same URLs, same shapes, same integration-key auth
- [ ] Digio eSign (webhook + poller), Decentro KYC/penny-drop v3, payments adapters
      (Cashfree/Easebuzz, stub-default), AWS SES email queue, WappCloud WhatsApp
      (acknowledgment + interest-credit templates), SharePoint offsite backup,
      AWS SSM secrets
- [ ] Agent-event webhook dispatcher to LockerHub
- [ ] Notification queue (email/SMS/WhatsApp) with cron drain + per-template files

## 12. Imports & ops

- [ ] Backdated/historical Excel importers (idempotent, deterministic dedup keys —
      port the rules from the old CLAUDE.md "Bulk uploads MUST be idempotent")
- [ ] Daily book summary email, daily backup-check email (local + offsite + secret
      expiry), crash-alert emails, LockerHub reconciliation cron
- [ ] Health endpoint, graceful shutdown, unhandled-rejection safety
- [ ] Nightly pg_dump + SharePoint offsite copy (reuse existing script pattern)
