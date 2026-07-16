# New Wealth — Dhanam NCD Platform (Rewrite)

> **Status:** Architecture complete. Implementation not started.
> **Architect:** Claude Fable 5 (2026-07-16). **Builder:** to be handed to Claude Opus.
> **This folder is a brand-new, standalone project.** It must never modify anything in
> `/Users/surens/tools/wealth` (the current production app). The old app stays live and
> untouched; data migrates here later (see `docs/09-migration.md`).

## What this is

A ground-up rewrite of **Dhanam Wealth** (the NCD operations platform for Dhanam
Investment and Finance Private Limited) as a **lightweight, modular, single-page
application** with a clean REST API. Functionality is preserved 1:1 from the current
app (see `docs/00-feature-inventory.md`); the look and feel is redesigned to be clean,
professional and uncluttered, following the visual language of
`reports.dhanamfinance.com`.

**Brand rule (unchanged):** legal name *Dhanam Investment and Finance Private Limited*,
short form *Dhanam*. Never "Dhanam Finance".

## Locked decisions (confirmed by owner, 2026-07-16)

| Decision | Choice |
|---|---|
| Frontend | React 18 + Vite + TypeScript SPA |
| Backend | Node.js + Express + TypeScript REST API (modular monolith) |
| Database | PostgreSQL 16, new database `dhanam_newwealth`, raw `pg` + `node-pg-migrate` |
| Hosting | Same EC2 box as current app, **new subdomain + new port + own systemd unit** |
| Roles | Exactly 8: Super Admin, Admin, CXO, NCD Manager, Branch Manager, Branch Staff, Agent, Customer. Legacy roles (wealth_manager, finance, reports_manager, ho_admin) are dropped; their users are mapped at migration. |
| Approvals | Maker-checker preserved: **nobody approves their own submission**, ever. NCD Manager holds both maker and checker rights but a *different* user must check. |
| Configuration | **Zero hardcoded business values.** Every rate, percentage, threshold, format and label that is business data lives in the DB and is editable in the Admin → Settings UI. See `docs/07-configuration.md`. |
| Integrations | All external API contracts preserved **byte-compatible** (LockerHub / DhanamFin app, Digio, Decentro, SES, WappCloud, payments). See `docs/08-integrations.md`. |

## Document index (read in order)

| Doc | Contents |
|---|---|
| `docs/00-feature-inventory.md` | Exhaustive checklist of every feature that must exist. The build is not done until every box is ticked. |
| `docs/01-architecture.md` | System design: monorepo layout, modular monolith, cross-cutting concerns, tech choices with rationale. |
| `docs/02-data-model.md` | New schema (entities, key columns, constraints), numbering schemes, domain formulas that must not change. |
| `docs/03-rbac.md` | The 8 roles, full permission matrix, data-scoping rules, approval chains. |
| `docs/04-api-spec.md` | REST conventions, module-by-module endpoint inventory, error shape, auth. |
| `docs/05-ui-ux.md` | Design system (tokens extracted from reports.dhanamfinance.com), app shell, navigation, screen inventory per role. |
| `docs/06-reports-and-exports.md` | Dashboard spec, the 9-tab Excel export (exact layouts), customer/district/agent/staff segmentation views. |
| `docs/07-configuration.md` | The settings registry: what is configurable, how it is typed, the Admin Settings UI. |
| `docs/08-integrations.md` | External integration contracts that must be preserved, adapter pattern, secrets. |
| `docs/09-migration.md` | Data migration plan from the old `dhanam_wealth` DB, reconciliation checks. |
| `docs/10-deployment.md` | EC2 co-tenant deployment, SSM secrets, nginx, systemd, backups. |
| `docs/11-build-plan.md` | Phased build order with acceptance criteria — the builder's roadmap. |

## Ground rules for the builder (Opus)

1. **Never touch `/Users/surens/tools/wealth`.** Reference it read-only when porting
   business logic (interest math, TDS, incentive matrix, integration adapters).
2. **Confidentiality:** the owner's spreadsheets and screenshots are sensitive. Never
   copy real customer names, amounts, PANs or phone numbers into code, fixtures, docs,
   commits or memory. Use synthetic data for seeds and tests.
3. **Port the money math verbatim** from `wealth/app/src/services/schedule.js` and the
   locked vitest worked examples — formulas in `docs/02-data-model.md` §6 are contract.
4. **No hardcoded business values.** If you find yourself typing `2.0` or `10` or
   `'28'` (payout day) into logic, stop and route it through the settings registry.
5. Every state-changing action writes an audit row. Every list screen has an empty
   state, a loading state and an error state. Every money number is `Number()`-coerced
   before math/sort (Postgres numerics arrive as strings).
6. Ask the owner before deviating from any locked decision above.
