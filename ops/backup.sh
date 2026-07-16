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

# Retention: keep 30 days locally.
find "$DIR" -name 'dhanam_newwealth-*.sql.gz' -mtime +30 -delete

# Offsite (optional): reuse the existing SharePoint uploader/Azure app from the
# current wealth app if configured — same 'Dhanam Repository' site, a
# NewWealthBackups/ folder. Left as a follow-up so this script never blocks the
# local dump if SharePoint is down.
