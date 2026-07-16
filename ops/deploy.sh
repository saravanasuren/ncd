#!/usr/bin/env bash
# Deploy Dhanam New Wealth on the EC2 box. Run from the repo root on the box.
# Loop: git pull → build → migrate → restart → health-check (auto-rollback).
set -euo pipefail

REPO=/home/ubuntu/new-wealth
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
for s in dashboard lockers odpulse wealth ncd; do
  echo -n "$s: "; curl -sI "https://$s.dhanamfinance.com/" 2>/dev/null | head -1 || echo unreachable
done
