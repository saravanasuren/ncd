#!/usr/bin/env bash
# Nightly pg_dump of the New Wealth DB → /var/backups/dhanam-newwealth.
# Install to /usr/local/bin/dhanam-newwealth-backup.sh and cron it:
#   0 21 * * * /usr/local/bin/dhanam-newwealth-backup.sh   (21:00 UTC = 02:30 IST)
set -euo pipefail

DIR=/var/backups/dhanam-newwealth
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$DIR/dhanam_newwealth-$STAMP.sql.gz"

DATABASE_URL=$(aws ssm get-parameter --name /dhanam/newwealth/DATABASE_URL \
  --with-decryption --region ap-south-1 --query Parameter.Value --output text)

pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip > "$FILE"
echo "wrote $FILE ($(du -h "$FILE" | cut -f1))"

# Offsite copy → SharePoint (non-fatal: the local dump above is already safe).
# Reuses the old app's Azure/SharePoint app; params live in SSM /dhanam/newwealth/*.
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/upload-sharepoint.mjs" ]; then
  R="--region ap-south-1 --query Parameter.Value --output text"
  export SHAREPOINT_TENANT_ID=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_TENANT_ID $R 2>/dev/null || true)
  export SHAREPOINT_CLIENT_ID=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_CLIENT_ID $R 2>/dev/null || true)
  export SHAREPOINT_CLIENT_SECRET=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_CLIENT_SECRET --with-decryption $R 2>/dev/null || true)
  export SHAREPOINT_BACKUP_DRIVE_ID=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_BACKUP_DRIVE_ID $R 2>/dev/null || true)
  export SHAREPOINT_BACKUP_FOLDER=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_BACKUP_FOLDER $R 2>/dev/null || echo NewWealthBackups)
  node "$HERE/upload-sharepoint.mjs" "$FILE" || echo "[backup] offsite copy failed — local dump is safe"
fi

# Retention: keep 30 days locally. (Offsite SharePoint copies are kept as an archive.)
find "$DIR" -name 'dhanam_newwealth-*.sql.gz' -mtime +30 -delete
