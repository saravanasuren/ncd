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
sleep 3

echo "==> health check"
if curl -fsS "$HEALTH" >/dev/null; then
  echo "OK — deployed $(git rev-parse --short HEAD)"
else
  echo "HEALTH FAILED — rolling back to $PREV"
  git reset --hard "$PREV"
  npm ci && npm run build
  sudo systemctl restart "$SERVICE"
  exit 1
fi

# Verify all five co-tenants are still up.
for s in lockers odpulse wealth reports cb ncd; do
  echo -n "$s: "; curl -sI "https://$s.dhanamfinance.com/" 2>/dev/null | head -1 || echo unreachable
done
