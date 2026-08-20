#!/usr/bin/env bash
#
# Restore drill — proves the newest backup can actually be restored.
#
#   Install: sudo cp ops/restore-drill.sh /usr/local/bin/dhanam-newwealth-restore-drill.sh
#   Cron:    0 5 1 * * /usr/local/bin/dhanam-newwealth-restore-drill.sh >> /var/log/dhanam-newwealth-restore-drill.log 2>&1
#            (05:00 UTC on the 1st — an hour after boarddesk's drill, so two
#             heavy jobs never run at once)
#
# Restores into a THROWAWAY database, checks the data is really there, then drops
# it. The live database is never written to; it is only read, to compare counts.
#
# Why this exists (2026-08-20): a duplicate cron line had two backups writing the
# same file at once. The 17 Aug dump lost 5 tables' data and nobody knew for
# three days, because a dump that exists looks exactly like a dump that works.
# An untested backup is a hope, not a backup.
set -uo pipefail

DIR=/var/backups/dhanam-newwealth
SCRATCH="ncd_drill_$$"
FAILED=0

note() { echo "[drill] $*"; }
fail() { echo "[drill] FAIL: $*" >&2; FAILED=1; }

cleanup() { sudo -u postgres dropdb --if-exists "$SCRATCH" >/dev/null 2>&1; }
trap cleanup EXIT

note "$(date -u +%Y-%m-%dT%H:%M:%SZ) starting"

# Defaults to the newest backup; pass a path to drill a specific one (which is
# also how you check an older dump you have doubts about).
DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  DUMP=$(ls -1t "$DIR"/dhanam_newwealth-*.sql.gz 2>/dev/null | head -1)
fi
[ -n "$DUMP" ] || { fail "no backups in $DIR"; exit 1; }
[ -r "$DUMP" ] || { fail "cannot read $DUMP"; exit 1; }
note "newest backup: $DUMP ($(du -h "$DUMP" | cut -f1))"

# The live database, read-only — the yardstick for "did the whole thing restore".
DATABASE_URL=$(aws ssm get-parameter --name /dhanam/newwealth/DATABASE_URL \
  --with-decryption --region ap-south-1 --query Parameter.Value --output text)
LIVE_DB=$(echo "$DATABASE_URL" | sed -E 's|.*/([^?]+).*|\1|')

# Guard: never, under any circumstances, restore over the live database.
if [ "$SCRATCH" = "$LIVE_DB" ]; then
  fail "scratch name collides with the LIVE database ($LIVE_DB) — refusing to run"
  exit 1
fi

# 1. Is the file even intact? This is the check that would have caught 17 Aug.
#
#    Run gzip ONCE and classify its message. Two traps here, both hit while
#    writing this: `gzip -t` exits NON-ZERO for mere trailing garbage, and with
#    `pipefail` a `gzip | grep` test reports gzip's status, not grep's — so the
#    obvious spelling calls a recoverable file damaged.
GZ_OUT=$(gzip -t "$DUMP" 2>&1); GZ_RC=$?
if [ "$GZ_RC" -eq 0 ]; then
  note "gzip: clean"
elif printf '%s' "$GZ_OUT" | grep -q 'trailing garbage'; then
  # A complete stream with extra bytes stuck on the end. Restorable, but it means
  # something wrote to this file twice — exactly the duplicate-cron signature.
  note "gzip: trailing garbage — restorable, but something wrote to this file twice"
else
  fail "gzip reports the backup is damaged: $GZ_OUT"
fi

# 2. Restore it into the scratch database.
#
#    Decompress to a file FIRST rather than piping straight into psql. With
#    pipefail, gzip's trailing-garbage exit code fails the whole pipeline and the
#    failure gets blamed on psql — which is what happened on the first run of
#    this script. Separating the two keeps the psql error readable.
SQL=$(mktemp /tmp/ncd-drill-XXXXXX.sql)
trap 'cleanup; rm -f "$SQL"' EXIT
gzip -dc "$DUMP" > "$SQL" 2>/dev/null || true
[ -s "$SQL" ] || { fail "decompressed to an empty file"; exit 1; }
note "decompressed: $(du -h "$SQL" | cut -f1)"

sudo -u postgres createdb "$SCRATCH" || { fail "could not create scratch database"; exit 1; }
chmod 644 "$SQL"   # the postgres user has to be able to read it
ERR=$(mktemp)
if ! sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d "$SCRATCH" -f "$SQL" >/dev/null 2>"$ERR"; then
  fail "psql restore failed:"; tail -8 "$ERR" >&2; rm -f "$ERR"; exit 1
fi
rm -f "$ERR"
note "restored into $SCRATCH"

q()    { sudo -u postgres psql -tAq -d "$SCRATCH" -c "$1" 2>/dev/null | tr -d ' '; }
live() { psql "$DATABASE_URL" -tAq -c "$1" 2>/dev/null | tr -d ' '; }

# 3. Is the DATA there? A restore that "succeeds" into an empty schema is the
#    failure this drill exists to catch, so compare against live.
TABLES=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
note "tables restored: ${TABLES:-0}"
[ "${TABLES:-0}" -gt 20 ] || fail "only ${TABLES:-0} tables — that is not a whole database"

for t in customers applications application_lines users nominees; do
  R=$(q "SELECT count(*) FROM $t"); L=$(live "SELECT count(*) FROM $t")
  if [ -z "$R" ] || [ -z "$L" ]; then fail "could not count $t (restored='$R' live='$L')"; continue; fi
  # Live moves on after the backup was taken, so restored ≤ live is expected;
  # restored ABOVE live, or a big shortfall, is not.
  if [ "$R" -gt "$L" ]; then
    fail "$t: restored $R > live $L — the backup does not match this database"
  elif [ "$L" -gt 0 ] && [ "$R" -lt $(( L * 90 / 100 )) ]; then
    fail "$t: restored $R vs live $L — more than 10% missing"
  else
    note "$t: $R restored / $L live"
  fi
done

# 4. The money. Row counts can look right while numeric columns came back empty.
BOOK=$(q "SELECT COALESCE(sum(total_amount),0)::bigint FROM applications WHERE archived_at IS NULL")
note "book value in the restored copy: ${BOOK:-0}"
[ "${BOOK:-0}" -gt 0 ] || fail "restored book value is zero — the amounts did not come back"

if [ "$FAILED" -eq 0 ]; then
  note "PASS — this backup restores and the data is there"
else
  note "DRILL FAILED — the newest backup cannot be trusted; look at the lines above"
fi
exit "$FAILED"
