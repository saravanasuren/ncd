# 11 — Build Plan (for the implementing agent)

Phased so that **money math is proven first** and every phase ends demoable.
Reference the old repo read-only at `/Users/surens/tools/wealth` when porting logic.
Never modify it. Never put real customer data anywhere.

## Phase 0 — Scaffold (foundation)
Monorepo (npm workspaces): `packages/shared`, `api`, `web`, `ops`. TypeScript strict,
eslint/prettier, vitest, GitHub Actions CI, docker-compose Postgres, node-pg-migrate
wiring, `.env.example`. Express app skeleton with error envelope, health endpoint,
request logging. Vite + React + Tailwind skeleton with tokens.css (doc 05 §1), the
AppShell, login page.
**Done when:** CI green; `npm run dev` shows the shell; health 200.

## Phase 1 — Core domain engine (no UI, test-first) 🔒
Port from old app into `api/src/lib` + `modules/schedule`:
interest math (option-b), TDS computation, incentive matrix resolution, redemption
math, numbering service, state machines. **Write the vitest fixtures FIRST from the
old app's locked worked examples** (Ramesh ₹5L example, TDS branches incl. 15G
expiry + LDC windows, all 4 matrix cells incl. flat-vs-pct, transition legality).
Schema migrations for docs 02 §1–§7 + seeds (roles, permissions, settings catalog,
synthetic demo data).
**Done when:** money tests green and reviewed against old-app outputs side by side.

## Phase 2 — Auth, RBAC, settings, masters
Cookie JWT + refresh + CSRF; permission catalog + middleware + `usePermission`;
users/branches CRUD; settings registry API + Admin Settings UI; products module
(schemes/series/TDS rules/holidays/company profile/banks) + screens.
**Done when:** all 8 roles log in and see role-correct nav; a setting edit round-trips
with audit; a new series can be configured entirely in UI.

## Phase 3 — Customer funnel
Leads (+notes, dedup, convert) → customer wizard (draft/resume) → Customer 360 →
bank accounts (penny-drop via stub adapter) → KYC (manual + provider stubs) →
corrections + handover workflows → approvals engine (generic, no-self-approve) with
the Approvals screen.
**Done when:** Branch Staff creates lead→customer→application-ready flow end-to-end
on synthetic data; NCD Manager queue shows the handoff; scope rules verified per role.

## Phase 4 — Investments & money engine
Applications (create, clubbing, receipt, collection confirm) → eSign (stub + webhook
+ manual) → batch allotment (maker-checker) → schedule materialisation → application
detail with schedule → payouts (NEFT preview/batch/download in Federal format,
statement matching, mark paid/failed) → redemptions (premature 2-level with date
re-confirm; **regression test: approval closes the application** — the old app's
known bug) → rollover/transfer/transformation → incentives (accruals, eligibilities,
referrers, payout ledger, payroll batches, my-earnings).
**Done when:** full lifecycle runs on synthetic book: lead → Active → interest batch
paid → premature redemption → incentives accrued and paid; every approval requires a
second user.

## Phase 5 — Dashboards, reports, exports
SQL views (doc 02 §8) → dashboard per-role variants with drill popups → Segments
explorer (customer/district/agent/staff) → **the 9-tab Excel export** with filter
parity + reconciliation acceptance test (doc 06 §3) → SOA/registers/TDS/dump reports
→ universal search.
**Done when:** doc 06 acceptance test passes; CXO login shows data-only experience;
export of a filtered view equals the on-screen numbers.

## Phase 6 — Portal + external integrations
Customer portal (OTP, holdings, payouts with cutoff ⚙, documents, requests) →
integration façade `/api/integration/*` with **contract tests written from the
legacy spec docs first** → agent self-signup + approval + webview session → real
provider adapters (Decentro v3, Digio, SES, WappCloud) behind stubs/flags →
notification queue + crons (dispatcher, reconciliation, daily summary, backup check).
**Done when:** contract test suite green; LockerHub Postman collection (old repo
`app/postman/`) passes against staging.

## Phase 7 — Hardening & deploy
Rate limits, security headers, audit browser, System screen, seed/demo polish,
`ops/` (systemd, nginx, deploy.sh, backup integration), deploy to the box on the new
subdomain, five-site health check.
**Done when:** app is live on the new subdomain with synthetic data; owner walkthrough.

## Phase 8 — Migration & cutover (doc 09)
ETL tool, dry-run, reconciliation gates, owner sign-off on role-mapping CSV +
district backfill list, joint cutover with LockerHub, 2-week parallel window.

---

### Standing orders (every phase)
- Feature-inventory (doc 00) boxes get ticked in the PR that lands them.
- No hardcoded business values — settings catalog or master data only.
- Every mutation audited; every scoped query takes `Scope`.
- Money numbers `Number()`/money.ts-coerced; amounts in paise internally.
- UI states (loading/empty/error) on every screen; design tokens only, no ad-hoc colours.
- Resolved by owner 2026-07-16: Excel tab layouts all confirmed (doc 06 §3, now
  9 tabs incl. Districtwise/Agent wise/Staff wise/Leads-by-status); premature
  redemption L2 approver = **CXO** (doc 03 §4 — wire CXO into the approvals queue
  for this type).
- Deferred by owner (non-blocking, decide before the relevant phase): final
  subdomain name (doc 10 — needed at Phase 7 deploy); role-mapping for legacy
  finance/reports_manager/ho_admin users (doc 09 — needed at Phase 8 migration).
