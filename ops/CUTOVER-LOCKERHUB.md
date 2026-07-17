# LockerHub → ncd integration cutover (NOT YET EXECUTED)

> Prepared 2026-07-16. Everything on the ncd side is deployed but **dormant**:
> LockerHub still points at the old wealth app, and every outbound ncd channel
> is gated on SSM values that are deliberately absent. Nothing switches until
> the steps below are run, in order, during a quiet window.

## What is already in place (ncd side)

- **Inbound façade** `/api/integration/*` — the full surface LockerHub calls on
  wealth today (customer reads L1–L10, customer auth LA1–LA4, writes, agents,
  stats), byte-compatible response shapes, behind `X-Integration-Key`
  (`/dhanam/newwealth/LOCKERHUB_INTEGRATION_KEY`).
- **Outbound agent-event webhooks** (customer_activated / incentive_accrued /
  incentive_paid): queue table + 30s dispatch cron, HMAC-signed
  (`X-Dhanam-Signature`/`X-Dhanam-Timestamp`, same contract as wealth).
  DORMANT until `LOCKERHUB_WEBHOOK_URL` + `LOCKERHUB_WEBHOOK_SECRET` exist in
  `/dhanam/newwealth/`.
- **Daily reconciliation** (LockerHub SQLite read-only vs ncd applications by
  `lockerhub_intent_no`; orphan email to admin roles). DORMANT until
  `LOCKERHUB_RECONCILIATION_ENABLED=true`. Manual run any time:
  `POST /api/system/lockerhub-reconciliation/run` (settings:manage).

## Pre-cutover checks (safe to run any day)

1. Compare live shapes: for a few real customers, diff
   `wealth:/api/integration/<path>` vs `ncd:/api/integration/<path>` responses
   (same key) — especially holdings `totals` block, `customer_status` mapping,
   penny-drop failure fields.
2. Run LockerHub's Postman collection (old repo `app/postman/`) against
   `https://ncd.dhanamfinance.com` in their staging.
3. Manual reconciliation run (above) — confirms the SQLite read path works and
   the report email arrives.

## Cutover steps (the actual flip — owner-coordinated)

1. **Freeze**: pick a low-traffic window; confirm the legacy book in ncd is
   current (re-run migrate-legacy delta if needed).
2. **Rotate keys** (docs/08 §3 — new values at cutover, never reuse wealth's):
   ```bash
   aws ssm put-parameter --region ap-south-1 --overwrite --type SecureString \
     --name /dhanam/newwealth/LOCKERHUB_INTEGRATION_KEY --value "$(openssl rand -hex 32)"
   aws ssm put-parameter --region ap-south-1 --overwrite --type SecureString \
     --name /dhanam/newwealth/LOCKERHUB_WEBHOOK_SECRET --value "$(openssl rand -hex 32)"
   ```
3. **Point LockerHub at ncd** (LockerHub `.env` — owner edits, single line each):
   - `WEALTH_API_URL=https://ncd.dhanamfinance.com`
   - `WEALTH_INTEGRATION_KEY=<the new integration key>`
   - webhook secret on LockerHub's verify side = the new webhook secret
   - `pm2 restart lockerhub`
4. **Enable ncd outbound**:
   ```bash
   aws ssm put-parameter --region ap-south-1 --overwrite --type String \
     --name /dhanam/newwealth/LOCKERHUB_WEBHOOK_URL --value "<LockerHub webhook URL>"
   aws ssm put-parameter --region ap-south-1 --overwrite --type String \
     --name /dhanam/newwealth/LOCKERHUB_RECONCILIATION_ENABLED --value "true"
   sudo systemctl restart dhanam-newwealth
   ```
5. **Verify**: DhanamFin app login → holdings render; one staging penny-drop;
   `journalctl -u dhanam-newwealth -f` for `[integration]`/`[agent-event]`;
   next morning's reconciliation email is clean.

## Rollback (single step)

LockerHub `.env`: restore `WEALTH_API_URL` to the old wealth URL + old key,
`pm2 restart lockerhub`. ncd keeps running; its outbound stays gated on its own
SSM values (delete `LOCKERHUB_WEBHOOK_URL` to silence webhooks immediately).
