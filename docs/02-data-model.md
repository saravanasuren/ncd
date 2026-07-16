# 02 — Data Model

New database `dhanam_newwealth`, PostgreSQL 16. Migrations via `node-pg-migrate`
(forward-only, idempotent where practical). This is a **clean redesign** of the old
~80-table schema down to ~45 tables: same information, normalised config, no legacy
vestiges. Old→new mapping lives in doc 09.

Conventions: `id BIGSERIAL PK`, `created_at/updated_at timestamptz`, soft business
keys unique-indexed, FKs `ON DELETE RESTRICT` (CASCADE only for pure child rows),
money `NUMERIC(14,2)`, rates `NUMERIC(7,4)`, statuses TEXT + CHECK against the
shared constants.

## 1. Identity & access

| Table | Purpose / key columns |
|---|---|
| `roles` | seeded 8 rows: super_admin, admin, cxo, ncd_manager, branch_manager, branch_staff, agent, customer |
| `role_permissions` | role_id, permission (string from the shared catalog) — editable view in Admin, seeded from `packages/shared/permissions.ts` |
| `users` | email UNIQUE, password_hash, full_name, phone, role_id, primary branch_id NULL, reports_to_user_id NULL, is_active. Agents and portal customers are **also users** (role agent/customer) so auth is uniform; agent/customer profile extras live in their own tables |
| `user_branches` | user_id, branch_id — **Branch Manager's multi-branch scope** (a manager sees every branch listed here) |
| `branches` | code UNIQUE, name, city, district, state, is_active |
| `agents` | user_id FK (nullable until self-signup approved), agent_code UNIQUE, source (manual \| dhanamfin), commission fields (eligibility status, rate ref → settings, payout mode, bank details), lockerhub identifiers 🔌 |
| `sessions` | refresh-token family (token_hash, user_id, expires_at, revoked_at, ua/ip) |
| `password_resets`, `portal_otp_sessions` | OTP flows (attempt caps, TTL) |

## 2. Customers

| Table | Key columns |
|---|---|
| `customers` | customer_code UNIQUE ⚙format, full_name, pan VARCHAR(15) UNIQUE (synthetic `CGRP_<slug>` allowed), dob, phone, email, address fields incl. **city, district ⚙list, state** (district drives district-wise reporting — required at enrolment), enrolled_by_user_id, branch_id, referred_by_text, kyc_status, creation_status (Draft→PendingApproval→Approved), is_active, is_deceased/deceased_date, portal_user_id NULL |
| `customer_bank_accounts` | account_number, ifsc, bank/branch name, holder name, penny_drop status + provider payload ref, is_active (partial unique: one active per customer), verified_at |
| `joint_holders` (≤2 ⚙), `nominees` (share %), `customer_documents` (KYC + uploaded docs, disk path, origin: staff \| dhanamfin 🔌) | |
| `customer_change_requests` | field-diff JSONB, source (staff \| portal \| lockerhub), approval_request_id |
| `customer_reassignments` | from/to user, reason, approval_request_id (one pending per customer, partial unique) |

## 3. Products & config

| Table | Key columns |
|---|---|
| `schemes` | code UNIQUE, name, tenure_months, payout_frequency ⚙, coupon_rate ⚙, face_value ⚙, min_ticket ⚙, multiple_of ⚙, commission_rule ⚙, tds_rule_id, is_active |
| `series` | code UNIQUE ("NCD 27"), name, status (Open/Closing/Closed/Withdrawn), face_value override ⚙, isin NULL, opened/locked/allotted timestamps + by |
| `series_schemes` | junction |
| `tds_rules` | kind (standard/15G/15H/custom/LDC), rate ⚙, thresholds ⚙, LDC validity window |
| `holidays` ⚙, `banks` ⚙ (company accounts), `company_profile` (singleton id=1: legal_name, former_legal_name, tan, tan_holder_name, tan_amendment_pending, signatory, default accounts) | |
| `app_settings` | **the settings registry** — key UNIQUE, value JSONB, type, group, label, description, updated_by/at. See doc 07. |

## 4. Investments

| Table | Key columns |
|---|---|
| `applications` | application_no UNIQUE ⚙format, customer_id, series_id, status (state machine), total_amount, amount_received, date_money_received, collection_method ⚙ + reference, interest_start_date, allotment_date, maturity_date, redemption_date, batch_allotment_id, payout_bank_account_id NULL (NULL = customer's active), receipt file fields, esign fields (provider ref, signed_at), `customer_was_new_at_creation BOOLEAN` (stamped at INSERT, never re-derived), `is_locker_deposit` 🔌, lockerhub_intent_no UNIQUE NULL 🔌, source (staff \| dhanamfin \| import), enrolled_by_user_id, enrolled_by_agent_id |
| `application_lines` | scheme_id NULL (imports), coupon_rate/tenure/frequency snapshot, amount, outstanding_amount, maturity_date, status |
| `disbursement_schedule` | **the heart.** line_id FK CASCADE, due_date, due_type (Interest/BrokenInterest/Redemption/Premature), gross, tds, net (CHECK net = gross − tds ± 0.01), status (Scheduled/Paid/Failed/Skipped), paid_at, utr, batch_id NULL, snapshotted payee bank fields, failure fields. UNIQUE (line_id, due_date, due_type) |
| `collections` | per-application receipts (method, reference, date, amount) |
| `redemptions` | redemption_no ⚙, application_id, type (premature/maturity), principal, penalty ⚙calc, net_payment, broken_interest (paid separately), requested/approved dates, approval_request_id, utr, status |
| `rollovers`, `holder_transfers`, `ncd_transfers`, `ncd_transformations` | lineage refs old↔new application/customer, approval_request_id, nominee bank capture (transformations) |
| `allotment_batches` | series_id, allotment_date, isin, notes, approval_request_id, reverted fields |
| `payment_intents` 🔌 | LockerHub/Easebuzz funding idempotency |

## 5. Money-out & incentives

| Table | Key columns |
|---|---|
| `payout_batches` | batch_no, kind (interest \| redemption \| payroll), payout_date, totals, status (Draft→PendingChecker→Approved→Downloaded→Reconciled/Failed/Cancelled), approval_request_id, xlsx audit fields |
| `commission_accruals` | agent_id, application/schedule refs, trigger, amount, accrual_date, paid_at, paid_via_batch — UNIQUE composite for idempotency |
| `incentive_accruals` | staff user_id, application_id, matrix_cell (which of the 4 ⚙), rate used (snapshot), amount, paid_at |
| `referrers` | normalised free-text name (lower, whitespace collapsed) UNIQUE, eligibility status ⚙rate, bank details, hide flag |
| `referrer_accruals` | referrer_id, application_id UNIQUE (one-time %), rate snapshot, amount, paid_at |
| `incentive_payouts` | payee polymorphic (agent \| staff \| referrer), amount, paid_at, batch ref — **partial payments; balance = Σaccrued − Σpaid** |
| `bank_statements` / `bank_statement_lines` | uploads + matching state (covers the old sbi_statements too — one table, `source_bank` column) |

## 6. 🔒 Domain formulas — CONTRACT, port verbatim, lock with tests

1. **Interest (option-b, receipt-date driven).** `interest_start_date =
   max(latest collection date, series deemed date)`. Payouts on day ⚙**(30)** of each
   month (Feb → last day; holiday-adjusted backward to previous working day).
   **Default day-count convention ⚙ = `Thirty360` (denominator 360).** First
   (broken) period = `(30 − invest_day)` days: `principal × rate/100 × brokenDays/360`.
   Subsequent regular periods = flat `m×30` days (m = months per frequency):
   `principal × rate/100 × (m×30)/360`. Maturity = deemed date + tenure_months;
   principal returns as a `Redemption` row **on** maturity_date; any gap from the last
   regular 30th to maturity is paid as a separate `BrokenInterest` row on the first
   30th strictly after maturity. Other conventions supported per-scheme:
   `Actual365` (first row actual_days/365, rest 30/365), `Actual360`, `ActualActual`
   (leap-year-aware). **🔒 Locked worked example (from old `test/schedule.test.js`,
   these exact values must pass):** ₹5,00,000 @ 10% monthly, 36 months, invest
   Apr 15 2026, deemed Apr 1 2026 → first row = 15 broken days = **₹2,083.33**;
   regular months = 30 days = **₹4,166.67**; Redemption ₹5,00,000 on **2029-04-01**;
   maturity BrokenInterest = 2 days (Mar 30 → Apr 1) = **₹277.78**. Quarterly check:
   ₹1,00,000 @ 12%, invest on the 1st → full 90-day quarters = **₹3,000.00** each.
2. **TDS.** Rule resolved per scheme/customer (standard ⚙10% / 15G / 15H / custom /
   LDC window). Rate **snapshotted onto each schedule row at materialisation** —
   never auto-recomputed when rules change later.
3. **Incentive matrix** (all four rates ⚙ in settings; defaults shown):
   | Customer | Referrer named? | Staff | Referrer |
   |---|---|---|---|
   | brand-new | no | 2.0% | — |
   | brand-new | yes | 0% | 2.0% |
   | existing | no | 2.0% | — |
   | existing | yes | 0.25% | 0 (intrinsic) |
   Each rate ⚙ may be **flat ₹ or % of amount** (settings value is
   `{mode:'pct'|'flat', value}` — owner requirement).
4. **Redemption.** `Net Payment = Principal − Penalty` ⚙(penalty default 1%).
   Broken-period interest is paid **separately** in the next payout cycle — never
   rolled into Net Payment. Approval recomputes broken interest to the confirmed
   redemption date.
5. **Numbering** ⚙ (formats in settings, defaults): customers `DHN{6}`, applications
   `APP-YYYY-{6}`, disbursements `DSB-…`, collections `COL-…`, rollovers `ROL-…`,
   transfers `TRF-…`, redemptions `MCR-…`. Generated via a `numbering` service with a
   per-key counters table (`number_sequences`) — never `MAX()+1`.
6. **Postgres numerics are strings in JS.** Coerce at the repo edge; the shared
   `Money` type is a branded string parsed by `money.ts`.

## 7. Governance, ops & misc

| Table | Purpose |
|---|---|
| `approval_requests` | generic engine: request_type, entity ref, level, chain config snapshot ⚙, maker_user_id, per-level approver + timestamps, status, metadata JSONB. CHECK: approver ≠ maker (self-approval also blocked in service). |
| `investor_leads`, `lead_notes` | CRM (source ⚙, status ⚙, admin_only flag, lockerhub dedup keys 🔌) |
| `service_requests` | portal + LockerHub service tray 🔌 |
| `notifications_queue` | channel (email/sms/whatsapp), template, payload, status, provider_message_id, attempts |
| `agent_event_webhooks` 🔌 | outbound events to LockerHub (drained by cron) |
| `audit_log` | actor, action, entity_type/id, before/after JSONB, ip, at |
| `number_sequences` | key, next_value (row-locked increments) |
| `job_runs` | cron bookkeeping (job, started/finished, ok, note) |
| `import_batches` / `import_rows` | idempotent importers (deterministic dedup key per row, from source data) |
| `schema_migrations` | owned by node-pg-migrate |

## 8. Reporting views

Create SQL views so dashboard/reports/export share one definition of truth:
`v_active_book` (per application: customer, series, agent, staff, branch, district,
principal outstanding), `v_monthly_flows` (month × inflow/outflow by type),
`v_redemption_register`, `v_depositor_totals`, `v_agent_production`,
`v_staff_production`, `v_district_totals`. The 9-tab Excel export (doc 06) and the
dashboard drill-downs both read these views with the same filter parameters — the
export is guaranteed to equal what's on screen.
