# 10 — Deployment & Operations

> **Ops artifacts are built and live in `ops/`** (Phase 7): `DEPLOY.md`
> (step-by-step runbook with exact owner commands), `dhanam-newwealth.service`
> (systemd unit), `nginx-dhanam-newwealth.conf`, `deploy.sh` (pull→build→
> migrate→restart→health+rollback), `backup.sh`, `env.production.example`.
> Hardening in place: rate limits (auth/OTP/writes/integration), HSTS + trust
> proxy in prod, SSM secrets loader (`/dhanam/newwealth/*`), graceful shutdown.
> **Follow `ops/DEPLOY.md` for the actual deploy.**

Locked decision: **same EC2 box** as the current app (`3.110.0.79`, ap-south-1),
co-tenant #5, own subdomain + port + database + systemd unit. The co-tenant rule
applies unchanged: **only ADD files; never edit the other apps' nginx blocks**; after
any infra change, curl all five subdomains.

## 1. Topology on the box

| Item | Value |
|---|---|
| Subdomain | **`ncd.dhanamfinance.com`** (chosen 2026-07-16) — point DNS (GoDaddy) → `3.110.0.79` |
| Port | **3030** (3010 = old wealth/cb; 3020 = reports; 8080/3001 in use by co-tenants) |
| Repo clone | `/home/ubuntu/ncd/` (own GitHub repo + read-only deploy key — create repo at build start) |
| Process | `systemd dhanam-newwealth.service` (User=ubuntu, `node api/dist/index.js`, MemoryMax=512M, Restart=always, `ReadWritePaths=/var/lib/dhanam-newwealth /tmp`) |
| Static SPA | `web/dist/` served **directly by nginx** (immutable hashed assets, `index.html` no-cache); `/api/*` proxied to 127.0.0.1:3030 |
| DB | `dhanam_newwealth` (own PG user) on the box's Postgres 16 |
| Secrets | SSM `/dhanam/newwealth/*`, instance-role read policy extended (additive); `.env` on box = 4 lines only (NODE_ENV, PORT, SSM path, region) |
| Files | `/var/lib/dhanam-newwealth/` (kyc-docs, receipts) |
| TLS | certbot — add the new domain (new cert, don't touch existing ones) |
| Logs | `journalctl -u dhanam-newwealth` |

## 2. Build & release pipeline

- **CI (GitHub Actions):** on every push/PR — typecheck, lint, `vitest` (money math
  + contract tests), `vite build`. Never merge red.
- **Deploy loop:** Mac → push → box `git pull` → `npm ci --omit=dev && npm run
  build` (build server-side is fine at this scale; artifact-based deploys are a
  later option) → `node-pg-migrate up` → `sudo systemctl restart dhanam-newwealth`.
  One `ops/deploy.sh` script does all of it with a health-check gate + auto
  `git reset --hard` rollback on failed health check.
- Migrations: forward-only; anything touching money data requires a pre-migration
  `pg_dump` (script-enforced).

## 3. Ops parity (port the proven patterns)

- Nightly `pg_dump` for the **new** DB added to the existing backup script
  arrangement (new file, own cron line) + SharePoint offsite copy + daily
  backup-check email incl. the 2028-07-09 secret-expiry warning.
- Crash-alert emails, graceful shutdown, unhandled-rejection guard (doc 01 §4).
- `GET /api/health` monitored; add the 5th domain to the all-sites curl check.
- Rate limits on auth/OTP/write endpoints from day one ⚙ (the old app deferred
  this; don't).

## 4. Local development

- `docker compose up db` (Postgres 16) — or the box-less PGlite path for tests.
- `npm run dev` = Vite dev server (proxy `/api` → localhost:3030) + tsx-watch API.
- `.env` for dev only (JWT secret, DB url, all providers stubbed); SSM unused
  locally.
- Seed script: 8 roles, permission matrix, settings catalog defaults, synthetic
  demo book (NEVER real customer data) — good enough to demo every screen.
