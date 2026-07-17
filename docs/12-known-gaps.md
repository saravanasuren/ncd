# Known gaps — production readiness register

> Audited 2026-07-16 against the deployed app (ncd.dhanamfinance.com, commit `4afda27`)
> by cross-referencing docs/00-feature-inventory.md, every API route, every web page,
> and the permission catalog. **Update this file as gaps close.**
> Note: docs/00-feature-inventory.md has 0/80 boxes ticked — the checklist was never
> maintained during the build; this file is the current source of truth for what's missing.

## P0 — misleading or wrong in production today

- [~] **KYC — LIVE via Decentro since 2026-07-16 evening** (adapter ported from the
  wealth app; keys copied from /dhanam/wealth/*): PAN verify + BAV-v3 penny drop
  with real account_status verdicts and local fuzzy name-match. Still stubbed:
  DigiLocker/Aadhaar uistream (needs session model + callback route), CKYC.
  NOTE: first real penny-drop/PAN call not yet fired — exercise on first
  customer bank-add and watch `journalctl -u dhanam-newwealth` for [decentro].
- [~] **Notifications — email LIVE via SES since 2026-07-16 evening** (instance-role
  auth, same verified identity as the wealth app; verified end-to-end — queued
  row drained with a real SES message id). WhatsApp wired via WappCloud for the
  approved OTP template (portal_otp); other WhatsApp templates fail gracefully
  until approved counterparts exist. SMS still stub (Moplet port pending —
  LockerHub owns SMS today). Portal OTP now deliverable via email/WhatsApp.
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
- [~] Users: edit/deactivate/password-reset UI added 2026-07-16; delete
  (users:delete, confirm-gated) + reports-to in create form added later same day.
  Still no UI for: multi-branch (`PUT /users/:id/branches`), reports-to on edit.
- [~] Customers — MOSTLY CLOSED 2026-07-16: direct enrolment form + server-backed
  search box on Customers page; KYC reject (with reason) on the customer page.
  Still API-only: correction-request, handover-request.
- [x] Leads — CLOSED 2026-07-16: full create form (all API fields; source/status
  vocab from the settings registry via new authed GET /api/settings/ui-config),
  duplicate-phone warning while typing, per-lead notes history (new GET
  /api/leads/:id/notes), inline edit of status/follow-up/expected.
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
- [~] Payouts/statements — CLOSED 2026-07-16: uploaded-statements list on the
  Payouts page; "mark failed" on Scheduled schedule rows (application page,
  payouts:mark-paid-manual). Still API-only: *agent* eligibility grant/revoke.
  (Payee balances and *referrer* eligibility were already wired — 2026-07-16.)
- [ ] Portal: service-requests endpoints unused; documents list has no real download
  links (only the SOA PDF generator exists — bond certificate / allotment letter /
  acknowledgment PDFs not built).
- [x] Admin: manual "Drain queue now" button on System → Notifications — CLOSED
  2026-07-16.

## P2 — reports & dashboard deltas vs docs/00

- [ ] Series-wise rollup XLSX; 26Q 17-column TDS filing layout (current TDS register
  is 7 columns); report filter UI (backend `BookFilters` plumbed, no controls).
- [ ] Dashboard: lead KPI funnel, ALM tiles (net due/overdue/paid FY), cost-of-funds
  rate mix, "today's book" additions/deletions.

## P3 — ops & integrations

- [x] Provider keys — CLOSED 2026-07-16: Decentro/WappCloud/notifications params
  copied from the wealth app's SSM (13 params); Digio keys exist in
  /dhanam/wealth/DIGIO_* for when the eSign webhook gets built.
- [ ] Digio eSign: only manual mark-esigned exists; no webhook/poller.
- [ ] Payment adapters (Cashfree/Easebuzz): nothing behind the stub default.
- [~] Crons from docs/00 §12: backup-check email (DONE 2026-07-17) and LockerHub
  reconciliation (DONE, cutover-gated) now exist. Still missing: daily
  book-summary email, crash-alert emails.
- [x] Backup offsite — CLOSED 2026-07-17: nightly pg_dump uploads to SharePoint
  ('Dhanam Repository' site, NewWealthBackups/ folder) via Graph, reusing the
  wealth app's Azure app (SHAREPOINT_* copied to /dhanam/newwealth/*). Daily
  backup-check email (local + offsite freshness + Azure secret expiry reminder,
  exp 2028-07-09) — verified live: upload succeeded, 5 admin emails sent via SES.
  Manual run: POST /api/system/backup-check/run.
- [ ] ops/deploy.sh co-tenant check still curls dashboard.dhanamfinance.com, which has
  no DNS record (pre-existing) — noise on every deploy.
- [~] LockerHub/DhanamFin cutover — READY BUT NOT EXECUTED (2026-07-17): full
  inbound façade (L1–L10, LA1–LA4, writes, agents, locker-deposit flow) is
  deployed byte-compatible, 21 contract tests; outbound webhooks + daily
  reconciliation ported and dormant (SSM-gated). LockerHub still points at
  wealth. Flip procedure + pre-checks: ops/CUTOVER-LOCKERHUB.md — note the six
  consumer-derived endpoints there that need LockerHub's Postman collection run
  before cutover.

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
