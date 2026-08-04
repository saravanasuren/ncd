#!/usr/bin/env bash
# Nightly NCD data extract → SharePoint, for the consolidated investments
# dashboard (owner 2026-07-31).
#
# Separate from backup.sh on purpose. That one writes a pg_dump for disaster
# recovery; a dashboard cannot read a .sql.gz without restoring a whole
# database first. This writes the same book as flat CSV that Power BI / Excel /
# Sheets open directly.
#
# ncd-extract.xlsx is the primary artefact: one workbook, one tab per table.
# The CSVs go too — same rows, different reader (some BI tools ingest a plain
# CSV far more reliably than a sheet inside a workbook).
#
# Files are uploaded under FIXED names into one folder, overwriting yesterday's,
# so the dashboard can point at a stable path instead of hunting for the newest
# dated folder. History is not kept here — the nightly pg_dump already is the
# archive, and a BI feed wants "current", not "every day forever".
#
# Install to /usr/local/bin/dhanam-ncd-extract.sh and cron it AFTER the backup:
#   30 21 * * * /usr/local/bin/dhanam-ncd-extract.sh >> /var/log/dhanam-ncd-extract.log 2>&1
#   (21:30 UTC = 03:00 IST)
set -euo pipefail

APP=/home/ubuntu/ncd/api
FOLDER=${SHAREPOINT_EXTRACT_FOLDER:-NcdDashboardExtract}

# A PRIVATE temp dir per run, not a fixed path. cron runs this as root, so a
# fixed /tmp/ncd-extract ends up root-owned — and the next person who runs the
# script by hand (to re-send after a SharePoint blip, say) cannot clear it and
# the run dies on `rm`. mktemp sidesteps ownership entirely, and the trap means
# a few MB of CSV never accumulate in /tmp after a failure.
OUT=$(mktemp -d -t ncd-extract-XXXXXX)
trap 'rm -rf "$OUT"' EXIT

echo "[extract] $(date -Is) starting"

# 1) Build the files. Reads SSM for DATABASE_URL exactly as the app does; the
#    script is read-only (SELECT only), so a failure here cannot corrupt data.
cd "$APP"
set -a; . ./.env; set +a
node dist/scripts/daily-extract.js --out "$OUT"

# 2) Ship them. Non-fatal on its own line so a SharePoint outage is reported
#    loudly but doesn't mask the fact that the extract itself succeeded — the
#    CSVs are still on disk and can be re-sent by re-running this script.
R="--with-decryption --region ap-south-1 --query Parameter.Value --output text"
export SHAREPOINT_TENANT_ID=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_TENANT_ID $R 2>/dev/null || true)
export SHAREPOINT_CLIENT_ID=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_CLIENT_ID $R 2>/dev/null || true)
export SHAREPOINT_CLIENT_SECRET=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_CLIENT_SECRET $R 2>/dev/null || true)
export SHAREPOINT_BACKUP_DRIVE_ID=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_BACKUP_DRIVE_ID $R 2>/dev/null || true)

node /home/ubuntu/ncd/ops/upload-sharepoint.mjs \
  "$OUT"/ncd-extract.xlsx \
  "$OUT"/customers.csv \
  "$OUT"/investments.csv \
  "$OUT"/interest.csv \
  "$OUT"/redemptions.csv \
  "$OUT"/series.csv \
  "$OUT"/staff.csv \
  "$OUT"/agents.csv \
  "$OUT"/incentives.csv \
  "$OUT"/summary.csv \
  "$OUT"/manifest.json \
  --folder "$FOLDER"

echo "[extract] $(date -Is) done → SharePoint/$FOLDER"
