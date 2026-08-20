#!/usr/bin/env bash
# Nightly pg_dump of the New Wealth DB → /var/backups/dhanam-newwealth.
# Install to /usr/local/bin/dhanam-newwealth-backup.sh and cron it:
#   0 21 * * * /usr/local/bin/dhanam-newwealth-backup.sh   (21:00 UTC = 02:30 IST)
set -euo pipefail

# Only ever one backup at a time (2026-08-20).
#
# The crontab had this script listed TWICE, both at 21:00. The filename below is
# derived from the timestamp, so both runs computed the SAME name in the same
# second and ran `pg_dump | gzip >` into one file — which produced an
# unrestorable dump on 17 Aug (5 of 66 tables' data cut off) and left junk
# appended to three others.
#
# The duplicate cron line is gone, but the collision was only ever possible
# because nothing stopped two runs overlapping. The lock lives HERE rather than
# in the crontab so it also covers a manual run started while cron's is going.
# Exits 0, not an error: a skipped duplicate is the lock working, not a fault,
# and cron should not mail about it.
LOCK=/var/lock/dhanam-newwealth-backup.lock
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[backup] another backup is already running — skipping this one"
  exit 0
fi

DIR=/var/backups/dhanam-newwealth
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$DIR/dhanam_newwealth-$STAMP.sql.gz"

DATABASE_URL=$(aws ssm get-parameter --name /dhanam/newwealth/DATABASE_URL \
  --with-decryption --region ap-south-1 --query Parameter.Value --output text)

# pipefail is on, so a pg_dump failure fails the script rather than leaving a
# neat little gzip of an error message.
pg_dump "$DATABASE_URL" --no-owner --no-acl | gzip > "$FILE"
echo "wrote $FILE ($(du -h "$FILE" | cut -f1))"

# Check the dump we just wrote is actually readable, before we call it a backup
# and before the offsite copy carries a broken file away. The 17 Aug damage sat
# unnoticed for three days precisely because nothing looked. Cheap: gzip -t
# streams, and the marker grep reads the tail of the decompressed SQL.
if ! gzip -t "$FILE" 2>/dev/null; then
  echo "[backup] FAILED: $FILE is not a valid gzip — refusing to treat it as a backup" >&2
  exit 1
fi
# NB: this pg_dump ends with a `\unrestrict` line, so the completion marker is
# NOT the last line — search the whole stream, not the tail.
if ! gzip -dc "$FILE" | grep -q 'PostgreSQL database dump complete'; then
  echo "[backup] FAILED: $FILE has no pg_dump completion marker — the dump is truncated" >&2
  exit 1
fi
echo "[backup] verified: valid gzip, dump complete"

# Offsite copy → SharePoint (non-fatal: the local dump above is already safe).
# Reuses the old app's Azure/SharePoint app; params live in SSM /dhanam/newwealth/*.
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/upload-sharepoint.mjs" ]; then
  # --with-decryption on every fetch: the params are copied from the wealth
  # app's SSM where even the tenant/client ids are SecureStrings — without
  # the flag the CLI returns ciphertext and Graph auth 404s.
  R="--with-decryption --region ap-south-1 --query Parameter.Value --output text"
  export SHAREPOINT_TENANT_ID=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_TENANT_ID $R 2>/dev/null || true)
  export SHAREPOINT_CLIENT_ID=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_CLIENT_ID $R 2>/dev/null || true)
  export SHAREPOINT_CLIENT_SECRET=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_CLIENT_SECRET $R 2>/dev/null || true)
  export SHAREPOINT_BACKUP_DRIVE_ID=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_BACKUP_DRIVE_ID $R 2>/dev/null || true)
  export SHAREPOINT_BACKUP_FOLDER=$(aws ssm get-parameter --name /dhanam/newwealth/SHAREPOINT_BACKUP_FOLDER $R 2>/dev/null || echo NewWealthBackups)
  node "$HERE/upload-sharepoint.mjs" "$FILE" || echo "[backup] offsite copy failed — local dump is safe"
fi

# Retention: keep 30 days locally. (Offsite SharePoint copies are kept as an archive.)
find "$DIR" -name 'dhanam_newwealth-*.sql.gz' -mtime +30 -delete
