# 01 — System Architecture

## 1. Shape: SPA + modular-monolith API

```
Browser ── React SPA (static files, nginx) ──► /api/* ──► Node/Express API (one process)
                                                              │
                                                              ├─ modules/* (domain logic)
                                                              ├─ PostgreSQL (dhanam_newwealth)
                                                              └─ integrations/* (LockerHub, Digio,
                                                                 Decentro, SES, WappCloud, payments)
```

**Why a modular monolith, not microservices:** one ops person, one t3.medium box,
< 100 concurrent users. A single deployable with strict internal module boundaries
gives the modularity/scalability the owner wants (modules can later be split out —
each owns its tables and exposes a typed service interface) without the operational
cost of distributed systems.

**Why this scales enough:** the current book is ~₹60 Cr / ~350 investors / ~750
transactions. Postgres + one Node process handles 100× that. Scaling levers, in
order: indexes → read replicas → extract the reporting module. None needed now, but
nothing in this design blocks them.

## 2. Monorepo layout

```
New_Wealth/
├── package.json                 npm workspaces root; scripts: dev, build, test, migrate
├── docs/                        these documents
├── packages/
│   └── shared/                  TypeScript types + zod schemas shared FE/BE
│       └── src/{types,schemas,constants,permissions}.ts
├── api/                         Express + TypeScript
│   ├── src/
│   │   ├── index.ts             boot: secrets → config → app → crons
│   │   ├── app.ts               express app assembly (middleware + module mounts)
│   │   ├── config.ts            validated env (zod)
│   │   ├── secrets.ts           AWS SSM loader (same pattern as old app)
│   │   ├── db/
│   │   │   ├── pool.ts          pg Pool + withTx()
│   │   │   └── migrations/      node-pg-migrate files (TS)
│   │   ├── middleware/          auth, rbac, error, rateLimit, audit, cache-control
│   │   ├── lib/                 pure helpers (dates, money, numbering, xlsx, pdf)
│   │   ├── modules/             ★ the domain modules (see §3)
│   │   ├── integrations/        kyc/, payments/, esign/, whatsapp/, sharepoint.ts,
│   │   │                        lockerhub/ (outbound events), email/
│   │   └── jobs/                cron registry + individual jobs
│   └── test/                    vitest (money math locked first — see build plan)
├── web/                         React + Vite + TypeScript
│   ├── src/
│   │   ├── main.tsx, App.tsx    router + providers
│   │   ├── api/                 typed client (fetch wrapper + TanStack Query hooks)
│   │   ├── auth/                session context, route guards, permission hooks
│   │   ├── components/          design-system components (doc 05)
│   │   ├── layouts/             AppShell (sidebar/topbar), PortalShell, AuthLayout
│   │   ├── features/            one folder per screen-domain, mirrors api/modules
│   │   └── styles/              tokens.css + tailwind config
│   └── index.html
└── ops/                         systemd unit, nginx block, deploy + backup scripts,
                                 migration ETL (doc 09)
```

## 3. API modules (each = routes + service + repo + zod schemas)

A module folder is `api/src/modules/<name>/{routes.ts, service.ts, repo.ts, schemas.ts}`.
Routes do HTTP only; services hold logic; repos hold SQL. Modules call each other
**only through service functions** (never each other's tables directly) — this is the
boundary that keeps the monolith modular.

| Module | Owns |
|---|---|
| `auth` | login/refresh/logout, password reset, sessions, CSRF |
| `users` | user CRUD, roles, branches master, reports-to |
| `settings` | the settings registry (doc 07) — read by every other module |
| `products` | schemes, series, series-schemes, TDS rules, holidays, company profile, banks |
| `leads` | investor leads + notes + conversion |
| `customers` | customers, joint holders, nominees, bank accounts, corrections, reassignment |
| `kyc` | KYC records/documents, provider calls via `integrations/kyc` |
| `applications` | applications + lines, lifecycle state machine, collection confirm, clubbing, receipts |
| `schedule` | interest engine + disbursement_schedule materialisation (pure core in `lib/interest.ts`) |
| `allotments` | batch allotment, revert, bond/allotment PDFs |
| `redemptions` | premature + maturity redemptions, rollovers, transfers, transformations |
| `payouts` | NEFT interest batches, statement matching, mark paid/failed |
| `incentives` | matrix accruals, agent commissions, referrer incentives, payout ledger, payroll batches |
| `approvals` | generic maker-checker engine (typed callbacks, TX-safe) |
| `dashboard` | KPI + drill endpoints (read-only, SQL views) |
| `reports` | SOA/registers/26Q + the 9-tab Excel export (doc 06) |
| `portal` | customer OTP auth + self-service endpoints |
| `integration` | **externally-consumed** LockerHub/DhanamFin endpoints (doc 08) — a façade over the other modules that must keep the legacy URL/shape contract |
| `notifications` | template rendering + queue + admin browser |
| `imports` | historical/backdated importers |
| `audit` | audit write helper + admin browser |

## 4. Cross-cutting decisions

- **TypeScript everywhere.** `packages/shared` holds the types and zod schemas both
  sides import — request/response shapes are validated at the API edge and typed in
  the UI. This is the single biggest reliability upgrade over the old app.
- **Validation:** zod on every route input. Reject unknown fields on writes.
- **Auth:** short-lived JWT access token + rotating refresh token, both HttpOnly
  Secure SameSite=Lax cookies. Mutations require `X-Requested-With: dhanam` (CSRF).
  Integration endpoints use the shared-key header exactly as today. Portal customers
  get OTP-established sessions. (Fixes the old app's localStorage-JWT debt from day one.)
- **RBAC:** a static permission catalog in `packages/shared/permissions.ts`
  (`resource:action` strings), role→permission map in DB (seeded, viewable in Admin),
  `requirePermission('applications:approve')` middleware + `usePermission()` hook so
  UI and API can never disagree. Data scoping (own/branch/all) is applied in repos
  via a `Scope` object every scoped query must accept. Details: doc 03.
- **Money:** all currency as `NUMERIC(14,2)` in DB, **strings over the wire**,
  converted at the edges with a `money.ts` helper (parse/format/round-half-even).
  Never float arithmetic on rupees; interest math uses integer paise internally.
- **Dates:** DATE columns for business dates, `timestamptz` for events. All business
  logic in IST semantics like the old app; store dates as dates, never local
  timestamps.
- **State machines:** application/series/redemption statuses defined in
  `shared/constants` with an `assertTransition(entity, from, to)` guard — port of the
  old `status.js`, kept as the only way statuses change.
- **Audit:** `withAudit(actor, action, entity, before, after)` wrapper used by every
  mutating service; writes inside the same TX.
- **Errors:** one error envelope `{ error: { code, message, detail? } }`; an
  `AppError(code, status, message)` class; global handler maps zod → 400, auth → 401,
  RBAC → 403, `assertTransition` → 409.
- **Background jobs:** `node-cron` registry in `jobs/`, production-gated, each job
  wrapped in try/catch + last-run bookkeeping in DB (visible in Admin → System).
- **File storage:** `/var/lib/dhanam-newwealth/` (KYC docs, receipts) — same
  systemd `ReadWritePaths` pattern as the old app.
- **Process safety:** port the old app's unhandledRejection/uncaughtException/
  SIGTERM handling and crash-alert email verbatim — it's proven.
- **Testing:** vitest. The interest/TDS/incentive/redemption math is ported **first**
  with the old app's locked worked examples as fixtures (they are formulas, not
  customer data), so parity is proven before any UI exists. Integration tests run
  the API against a disposable Postgres (or PGlite) per suite.
- **Frontend data:** TanStack Query for all server state (no global store needed);
  React Router; TanStack Table for grids (sort/filter/pin); Recharts for charts;
  `exceljs` **server-side** for styled multi-tab exports; Tailwind CSS + a small
  custom component kit (doc 05) — deliberately not a heavy UI framework.
- **No build-time coupling to the old app.** Business logic is *ported* (copied and
  TypeScript-ified), never imported across repos.

## 5. What we deliberately did NOT carry over

- The GL/Tally accounting tables, grievances, compliance-tracker and
  operational-reports pages that the 2026-04-28 rescope already abandoned — **confirm
  with owner before resurrecting; default is OUT.** (They are absent from the owner's
  brief; the feature inventory reflects the live app.)
- 40 separate HTML pages → ~25 SPA screens (doc 05 consolidates without burying
  features: everything reachable in ≤ 2 clicks from the sidebar or the universal
  search).
- The `?v=N` cache-buster convention — Vite hashes assets; `index.html` is served
  `no-cache`. The whole class of stale-sidebar bugs disappears.
