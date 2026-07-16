# Known gaps — production readiness register

> Audited 2026-07-16 against the deployed app (ncd.dhanamfinance.com, commit `4afda27`)
> by cross-referencing docs/00-feature-inventory.md, every API route, every web page,
> and the permission catalog. **Update this file as gaps close.**
> Note: docs/00-feature-inventory.md has 0/80 boxes ticked — the checklist was never
> maintained during the build; this file is the current source of truth for what's missing.

## P0 — misleading or wrong in production today

- [ ] **KYC is a stub in prod.** `KYC_PRIMARY_PROVIDER` defaults to `stub`: every bank
  account (except test patterns) penny-drop-"verifies" with holder name "VERIFIED
  HOLDER"; PAN verify is regex-only; DigiLocker returns a fake session
  (`api/src/integrations/kyc/stub.ts`, `customers/service.ts:247`). Staff must NOT
  trust "Verified" badges until the Decentro adapter lands + keys in SSM.
- [ ] **All notifications are stubs.** Email/SMS/WhatsApp providers return success
  without sending (`api/src/integrations/notify/index.ts`). This includes the
  **customer-portal OTP** — portal login is effectively unusable until SES/WappCloud
  adapters + keys land.
- [x] **Lead → convert posts hardcoded values** — FIXED 2026-07-16: inline convert
  form (amount prefilled from expected_amount + Open-series picker) replaces the
  hardcoded `100000 / series 1`.
- [~] **No password reset/change anywhere.** PARTLY CLOSED 2026-07-16: admins can now
  set a new password (and edit role/branch/name/active) from the Users screen.
  Still missing: self-service forgot/change password (the `/api/auth/forgot-password`
  rate limiter in `app.ts:68` still has no route handler; blocked on real email
  sending anyway — see notifications stub above).

## P1 — backend exists, no UI (feature unreachable; same pattern as the create-user gap fixed 2026-07-16)

- [x] Products/masters admin — CLOSED 2026-07-16: Masters page (Admin nav, gated
  `products:manage`) covers schemes, series (create/status/ISIN), TDS rules, banks,
  holidays, company profile.
- [x] NCD events — CLOSED 2026-07-16: NCD Events register page; rollover/transfer/
  transformation are initiated from the application page's lifecycle actions.
- [x] Redemption initiation — CLOSED 2026-07-16: premature (reason + optional date)
  and maturity initiation live in the application page's lifecycle actions.
- [~] Users: edit/deactivate/password-reset UI added 2026-07-16 (`PUT /users/:id`
  wired). Still no UI for: delete, multi-branch (`PUT /users/:id/branches`),
  reports-to.
- [~] Customers — MOSTLY CLOSED 2026-07-16: direct enrolment form + server-backed
  search box on Customers page; KYC reject (with reason) on the customer page.
  Still API-only: correction-request, handover-request.
- [ ] Leads: edit, notes/follow-up history, duplicate-phone check all API-only; create
  form missing place/category/referred-by/scheme/expected-amount/follow-up fields.
- [~] Applications — receipt upload CLOSED 2026-07-16 (upload/replace button on the
  application page, ≤4 MB; body-parser raised to 8 MB on upload routes so the cap
  is actually reachable). Approvals detail view + reject-with-reason CLOSED
  2026-07-16. Still API-only: clubbing candidates.
- [x] Upload hardening — CLOSED 2026-07-16 (found in re-audit): server-side
  magic-byte validation (JPEG/PNG/WebP/PDF only, 5 MB cap, sniffed mime stored)
  on receipts + KYC docs (staff, portal-mirror and integration paths); stored
  files now served with the sniffed type and sanitized Content-Disposition,
  unknown/legacy types download as attachment — closes a stored-XSS vector
  (client-controlled mime served inline with CSP off).
- [x] Nominee/joint-holder second-add 400 — FIXED 2026-07-16 (found in re-audit):
  route schemas now nullish, so UI round-trips of NULL fields validate.
- [ ] Payouts/statements/incentives: mark-row-failed, statements list, and *agent*
  eligibility grant/revoke — API-only. (Payee balances and *referrer* eligibility
  ARE wired via the Incentives page — corrected 2026-07-16 re-audit.)
- [ ] Portal: service-requests endpoints unused; documents list has no real download
  links (only the SOA PDF generator exists — bond certificate / allotment letter /
  acknowledgment PDFs not built).
- [ ] Admin: `POST /api/system/notifications/drain` (manual drain button) unused.

## P2 — reports & dashboard deltas vs docs/00

- [ ] Series-wise rollup XLSX; 26Q 17-column TDS filing layout (current TDS register
  is 7 columns); report filter UI (backend `BookFilters` plumbed, no controls).
- [ ] Dashboard: lead KPI funnel, ALM tiles (net due/overdue/paid FY), cost-of-funds
  rate mix, "today's book" additions/deletions.

## P3 — ops & integrations

- [ ] Live provider keys not in SSM: DECENTRO_*, DIGIO_*, WAPPCLOUD_*, SES/
  NOTIFICATIONS_* (blocked on owner obtaining keys).
- [ ] Digio eSign: only manual mark-esigned exists; no webhook/poller.
- [ ] Payment adapters (Cashfree/Easebuzz): nothing behind the stub default.
- [ ] Crons from docs/00 §12: daily book-summary email, backup-check email, LockerHub
  reconciliation, crash alerts — none exist (only the notification drain cron).
- [ ] Backup offsite: local nightly pg_dump IS live (ops/backup.sh, verified
  2026-07-16); SharePoint offsite upload still pending.
- [ ] ops/deploy.sh co-tenant check still curls dashboard.dhanamfinance.com, which has
  no DNS record (pre-existing) — noise on every deploy.
- [ ] LockerHub/DhanamFin cutover: integration façade is live behind
  `LOCKERHUB_INTEGRATION_KEY`, but the LockerHub app still points at the old wealth
  app; byte-compat of L1–L10/LA1–LA4 unverified against doc 08.

## P4 — minor / cosmetic (from 2026-07-16 re-audit)

- [ ] `customers:delete` permission is defined but orphaned — no route, no UI.
  Either build customer deletion (with guards) or drop the catalog entry.
- [ ] migrate-legacy report counts (`frozenRows`/`loadedPaidRows`) are table-wide,
  not migration-scoped — over-count if ever re-run on a non-empty DB.
- [ ] Masters/Events pages use hand-rolled tables, not the shared DataTable
  (no sort/filter there); DataTable's "Filter" toggle clears filters on collapse.

## Verified working (deployed + exercised 2026-07-16)

Login/RBAC/CSRF, user create (+branches endpoint), migrations, seed (after the
SSM-ordering fix), nightly local backup, TLS + auto-renew, health check + rollback in
deploy.sh, all co-tenant apps unaffected.
