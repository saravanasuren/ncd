# 04 — API Specification

## 1. Conventions

- Base path `/api`. JSON in/out. zod-validated bodies; unknown fields rejected on writes.
- **Auth:** HttpOnly cookie session (JWT access + rotating refresh). `POST /api/auth/refresh` rotates. Mutations require header `X-Requested-With: dhanam` (CSRF). `/api/integration/*` uses `X-Integration-Key` (unchanged from old app 🔌). `/api/portal/*` uses OTP-established customer sessions. `/api/webhooks/*` verified by provider secret.
- **Errors:** `{ error: { code, message, detail? } }` with proper status (400 validation, 401, 403, 404, 409 state-machine/conflict, 422 domain rule).
- **Lists:** `?page`, `?limit` (default 50, max 500 ⚙), `?sort`, `?filters` (typed per endpoint); response `{ rows, total, page, limit }`.
- **Money:** strings ("500000.00"). **Dates:** `YYYY-MM-DD` business dates; ISO timestamps for events.
- Every mutation is audit-logged (§cross-cutting, doc 01). Rate limits ⚙ on auth, OTP and write endpoints.
- Version-neutral: no `/v1` (single first-party consumer); the integration façade keeps whatever versioning the legacy contract had.

## 2. Endpoint inventory by module

Auth roles/scoping per doc 03; here only the surface. (P) = permission-gated, (S) = scope-filtered.

### auth
`POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` (incl. permissions + scope for UI) · `POST /auth/forgot-password` · `POST /auth/reset-password` · `POST /auth/change-password`

### users & masters
`GET|POST|PUT /users` (P) · `PUT /users/:id/branches` (Branch-Manager scope) · `DELETE /users/:id` (Super Admin) · `GET|POST|PUT /branches` (P) · `GET /roles` · `GET|PUT /role-permissions` (Admin, view + edit)

### settings ⚙
`GET /settings` (grouped registry, P) · `PUT /settings/:key` (typed, validated, audit) · `GET /settings/public` (safe subset the SPA needs pre-login: brand, formats)

### products
`GET|POST|PUT /schemes` · `GET|POST|PUT /series` · `POST /series/:id/launch` · `POST /series/:id/set-isin` · `GET|POST|PUT /tds-rules` · `GET|POST|PUT /holidays` · `GET|PUT /company-profile` · `GET|POST|PUT /banks` (all P)

### leads
`GET /leads` (S) · `POST /leads` · `PUT /leads/:id` · `POST /leads/:id/notes` · `POST /leads/:id/convert` (requires confirmed amount + series) · `GET /leads/duplicate-check?phone=` (returns owner + handover hint)

### customers
`GET /customers` (S; filters: status, series, branch, district, kyc) · `GET /customers/search?q=` (S, universal) · `GET|POST|PUT /customers/:id` · `POST /customers/:id/submit-for-approval` · wizard: `GET|PUT /customers/:id/draft` · `DELETE /customers/:id` (Super Admin) · `POST /customers/:id/deactivate|reactivate` · relations: `GET|PUT /customers/:id/joint-holders|nominees|demat` · bank: `GET|POST /customers/:id/bank-accounts`, `POST /bank-accounts/:id/set-active`, `DELETE /bank-accounts/:id` (guarded), `POST /customers/:id/penny-drop` 🔌 · corrections: `POST /customers/:id/correction-request` · handover: `POST /customers/:id/reassignment-request`, `GET /customers/lookup-locked?q=` (minimal fields) · `GET /customers/:id/documents` + `GET /documents/:docId` (streams)

### kyc
`POST /kyc/pan-verify` · `POST /kyc/digilocker/start|callback` · `POST /customers/:id/kyc/manual-verify|reject` (docs upload multipart)

### applications
`GET /applications` (S; filters: status, series, stage, creator) · `POST /applications` (multipart: receipt required for staff channel; `club_with_application_id` optional) · `GET /applications/:id` (with lines + schedule + timeline) · `POST /applications/:id/confirm-collection` · `POST /applications/:id/mark-esigned` (fallback) · `POST /applications/:id/payout-account` (re-snapshot future rows) · `GET /applications/:id/receipt` · `GET /applications/clubbing-candidates` · PDFs: `GET /applications/:id/form.pdf|allotment-letter.pdf|bond.pdf|acknowledgment.pdf` · `POST /applications/:id/send-acknowledgment` (WhatsApp 🔌)

### schedule
`GET /applications/:id/schedule` · `GET /schedule/summary` (ALM tiles) · (materialisation is internal, triggered by allotment)

### allotments
`GET /allotments/series` (pending counts) · `POST /allotments/series/:id` (maker → approval) · `POST /allotments/series/:id/revert` (Super Admin) · `GET /allotments/series/:id/bonds.pdf` (bulk)

### redemptions
`GET /redemptions` (S) · `POST /applications/:id/redemptions` (maker; premature or maturity; preview shows principal/penalty ⚙/broken-interest math) · approval happens via approvals module (set/confirm date there) · `GET /redemptions/neft.xlsx` · `POST /redemptions/:id/utr` · `GET /redemptions/report.xlsx` · rollover/transfer/transformation: `POST /applications/:id/rollover`, `POST /ncd-transfers`, `POST /ncd-transformations` (+ GET lists)

### payouts
`GET /payouts/preview?date=` · `POST /payouts` (maker) · `GET /payouts` · `GET /payouts/:id` (rows) · `GET /payouts/:id/download.xlsx` (status-gated, Federal Bank 12-col format preserved) · `POST /payouts/:id/rows/:rowId/mark-failed` · `POST /payouts/:id/mark-paid` · `POST /payouts/rows/:rowId/mark-paid` (Admin, reason required) · `POST /payouts/:id/cancel` · statements: `POST /bank-statements` (upload) · `POST /bank-statements/:id/run-match` · `POST /bank-statements/lines/:id/match|ignore`

### incentives
`GET /incentives/overview` (P) · agent commission: `GET|POST /agents/:id/eligibility`, `POST .../revoke` · referrers: `GET /referrers`, `POST /referrers/:id/eligibility|revoke|hide` · balances: `GET /payees/:type/:id/balance` · `POST /payees/:type/:id/pay` (partial amount-box) · `GET /my/earnings` (S) · payroll batches: `POST /payroll-batches` (maker) + download/mark-paid like payouts · `GET /performance/agents|staff` (S; production + owed drill)

### approvals
`GET /approvals/queue` (per-type tabs + badges; excludes own submissions from actionable set) · `GET /approvals/:id` (full context render: diffs, receipts, dates) · `POST /approvals/:id/approve` (per-type extra payload, e.g. confirmed redemption date, payout account) · `POST /approvals/:id/reject` (reason)

### dashboard
`GET /dashboard/kpis` (S) · `GET /dashboard/today-book` · `GET /dashboard/monthly-flows` · `GET /dashboard/series-register` · `GET /dashboard/rate-mix` · `GET /dashboard/districts` · drill-downs: `GET /dashboard/drill/:widget?params` (uniform: returns rows for the popup) · `GET /search?q=` (universal: customers/agents/staff)

### reports
`GET /reports/soa/:customerId.pdf` · `GET /reports/interest-tds-register.xlsx?from&to` (17-col) · `GET /reports/tds/:yyyymm.xlsx` · `GET /reports/series-wise.xlsx` · `GET /reports/dump.xlsx` (Admin) · **`GET /reports/ncd-book.xlsx?filters…` — the 9-tab owner export (doc 06 §3), scope- and filter-applied** · `GET /reports/segments/:by` (by ∈ customer|district|agent|staff — doc 06 §4)

### portal (customer)
`POST /portal/otp/request|verify` · `GET /portal/holdings|payouts|documents` · `GET /portal/documents/:id` · `POST /portal/service-requests` · `POST /portal/transfer-requests` (statement display cutoff ⚙ applied to lists, aggregates full)

### integration 🔌 (LockerHub / DhanamFin — legacy contract, byte-compatible)
Mounted at the **same paths as the old app** under `/api/integration/*` (customer reads L1–L10, writes, customer auth LA1–LA4, agent auth + email-check + webview session, KYC mirror). Full contract: doc 08. These are façade routes calling the same services as first-party routes.

### notifications / audit / imports / system
`GET /notifications` (admin browser) + `POST /notifications/:id/retry` · `GET /audit` (filters: entity, actor, date) · `POST /imports/backdated` (preview → run) · `GET /health` (public) · `GET /system/jobs` (cron last-runs) · `POST /webhooks/digio/esign-complete` 🔌

## 3. Non-negotiable behaviours to port

- State transitions only via the shared state machine — API returns 409 on illegal jumps.
- Approval TX atomicity: `onFinalApprove` side-effects commit/rollback with the approval row.
- Payout XLSX layouts (Federal Bank NEFT 12-col; redemption sheet) byte-format-identical to today's — banks parse them.
- Idempotent importers (deterministic dedup keys from source data).
- LockerHub-funded app statuses map to customer-facing "Active" exactly as today (`customer_status` mapping).
