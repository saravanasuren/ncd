#!/usr/bin/env bash
# Dev servers for this checkout (api + web), on this checkout's ports.
#
# Two jobs beyond the old `api & web` one-liner:
#
#  1. Load .env.cowork if present, so a co-work worktree runs on its OWN ports
#     instead of colliding with :3030 / :5173. The main checkout has no such
#     file and keeps the historic defaults.
#
#  2. Kill BOTH servers when you stop. The old form backgrounded the API and ran
#     vite in the foreground, so Ctrl-C killed vite and orphaned the API — which
#     then held :3030 and served stale code to the next session. That has bitten
#     us twice: once serving a stale `shared` build, once blocking a dev server
#     with EADDRINUSE.
set -euo pipefail

if [ -f .env.cowork ]; then
  set -a; . ./.env.cowork; set +a
  echo "[dev] worktree ports — api :${NCD_API_PORT} web :${NCD_WEB_PORT}"
fi

# Kill a process and everything below it, deepest first.
#
# `npm run dev` is a shallow wrapper: it spawns tsx, which spawns node; vite is
# the same shape. Signalling only the npm pid leaves those grandchildren alive,
# still holding the port. Verified — a plain `kill $pid` released neither :3199
# nor :5399. Process groups (`set -m` + `kill -- -pid`) look like the tidy answer
# but split the jobs into separate groups, so a real terminal Ctrl-C would then
# reach only this script and not the servers at all. Walking the tree works in
# both cases.
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

pids=()
cleanup() {
  trap - EXIT INT TERM
  local pid
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill_tree "$pid"
  done
  sleep 1
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

npm run dev -w @new-wealth/api & pids+=($!)
npm run dev -w @new-wealth/web & pids+=($!)

# Stop as soon as EITHER dies, so a crashed API doesn't leave a web server
# quietly proxying to nothing. `wait -n` is the obvious way and is what this
# first used — but macOS ships bash 3.2, where it does not exist, and `set -e`
# then killed the script on startup. Poll instead; it works everywhere.
while :; do
  for pid in "${pids[@]}"; do
    kill -0 "$pid" 2>/dev/null || exit 0   # EXIT trap stops the other one
  done
  sleep 1
done
