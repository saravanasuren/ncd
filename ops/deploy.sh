#!/usr/bin/env bash
# Deploy Dhanam New Wealth on the EC2 box. Run from the repo root on the box.
# Loop: git pull → build → migrate → restart → health-check (auto-rollback).
set -euo pipefail

# docs/09 footgun #2: a stale `export DATABASE_URL` in the operator's shell
# (e.g. left over from querying the old wealth DB) silently retargets the
# migrate step at the WRONG database. On the box, SSM is the only source of
# truth — drop any inherited value before anything runs.
unset DATABASE_URL LEGACY_DATABASE_URL

REPO=/home/ubuntu/ncd
SERVICE=dhanam-newwealth
HEALTH=https://ncd.dhanamfinance.com/api/health

cd "$REPO"
PREV=$(git rev-parse HEAD)
echo "==> git pull"
git pull --ff-only

echo "==> install (incl. dev deps for the build)"
npm ci

echo "==> build shared + api + web"
npm run build

echo "==> run DB migrations (idempotent — loads DATABASE_URL from SSM)"
export SSM_PARAMETERS_PATH=/dhanam/newwealth/
export SSM_REGION=ap-south-1
npm run migrate -w @new-wealth/api

echo "==> restart service"
sudo systemctl restart "$SERVICE"

# Wait for the API to answer rather than guessing how long it takes.
#
# This was a flat `sleep 3`, and on 2026-10-10 it rolled back a perfectly good
# deploy: the service restarted at 04:08:21, the script gave up at 04:08:24,
# and the app logged "listening on 127.0.0.1:3030" at 04:08:25 — one second
# late. Boot is ~4s now (loading 32 SSM parameters, then listening) and will
# only grow, so a fixed sleep is a race that gets worse. Poll instead: a
# healthy deploy still finishes in about the same time, and a genuinely broken
# one still rolls back, just 60s later.
echo "==> waiting for the API to answer (up to 60s)"
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done

echo "==> health check"
if [ "$HEALTHY" = "1" ]; then
  echo "OK — deployed $(git rev-parse --short HEAD)"
else
  echo "HEALTH FAILED — rolling back to $PREV"
  git reset --hard "$PREV"
  npm ci && npm run build
  sudo systemctl restart "$SERVICE"
  exit 1
fi

# Verify the co-tenants are still up. wealth is intentionally omitted — it's a
# sunset app that no longer auto-restarts, so its 502 is expected noise, not a
# deploy regression.
for s in lockers odpulse reports cb ncd; do
  echo -n "$s: "; curl -sI "https://$s.dhanamfinance.com/" 2>/dev/null | head -1 || echo unreachable
done
