#!/usr/bin/env bash
# Isolated worktrees for parallel Claude Code / co-work sessions.
#
# One checkout cannot hold two sessions: git keeps ONE branch, ONE index and ONE
# working tree per checkout, so two sessions editing the same directory will
# commit each other's files and move each other's HEAD. A worktree gives each
# session its own branch, index and files against the same repository — and this
# script also hands each one its own dev-server ports, so two `npm run dev`s
# don't fight over :3030.
#
#   ops/cowork.sh new <name> [base]   create a worktree (base defaults to origin/main)
#   ops/cowork.sh list                worktrees, their branches and ports
#   ops/cowork.sh rm <name>           remove one (refuses if it holds work)
#   ops/cowork.sh install-hooks       activate the commit guard (idempotent)
#
# See ops/COWORK.md.
set -euo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null || true)
[ -z "$root" ] && { echo "not inside a git repository" >&2; exit 1; }
# From inside a worktree, --show-toplevel is the worktree; we want the MAIN one.
common=$(git rev-parse --path-format=absolute --git-common-dir)
main_root=$(dirname "$common")
trees="$main_root/.claude/worktrees"

# Ports must not collide between worktrees, and must not collide with the main
# checkout's 3030/5173. Derive them from the name so they are stable across
# restarts — the same worktree always gets the same pair.
ports_for() {
  local name="$1" hash
  hash=$(printf '%s' "$name" | cksum | cut -d' ' -f1)
  echo "$((3100 + hash % 400)) $((5300 + hash % 400))"
}

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }

# Install the hook INTO THE GIT DIR, not the working tree.
#
# The obvious `core.hooksPath=ops/githooks` is a trap: that path resolves against
# whatever is currently checked out, so the hook silently does nothing on a
# checkout sitting on a commit that predates it — including, at first, the very
# main checkout this is meant to protect. Git does not warn about a missing hooks
# directory; it just runs no hook. Found the hard way: with hooksPath set that
# way, a test commit sailed straight onto main.
#
# So copy it under the common git dir — shared by every worktree, and immune to
# branch switches — and point at it absolutely. The tracked copy in ops/githooks
# remains the reviewable source; re-run this to re-sync after editing it.
cmd_install_hooks() {
  local src="$main_root/ops/githooks" dest="$common/cowork-hooks"
  # During bootstrap the main checkout may not have the tracked copy yet, so
  # fall back to the tree this script is running from.
  [ -d "$src" ] || src="$(cd "$(dirname "$0")" && pwd)/githooks"
  [ -d "$src" ] || { echo "cannot find ops/githooks" >&2; exit 1; }

  mkdir -p "$dest"
  cp "$src"/* "$dest"/
  chmod +x "$dest"/*
  git -C "$main_root" config core.hooksPath "$dest"

  # Prove it is live rather than assume — a guard that silently isn't running is
  # worse than none, because you stop checking.
  if [ -x "$dest/pre-commit" ] && [ "$(git -C "$main_root" config core.hooksPath)" = "$dest" ]; then
    echo "hooks → $dest (active for the main checkout and every worktree)"
  else
    echo "hook install FAILED — commits in the main checkout are NOT guarded" >&2
    exit 1
  fi
}

cmd_new() {
  local name="${1:-}" base="${2:-origin/main}"
  [ -z "$name" ] && { echo "usage: ops/cowork.sh new <name> [base]" >&2; exit 1; }
  case "$name" in *[!a-zA-Z0-9._-]*) echo "name: letters, digits, . _ - only" >&2; exit 1;; esac
  local dir="$trees/$name"
  [ -e "$dir" ] && { echo "already exists: $dir" >&2; exit 1; }

  git -C "$main_root" fetch origin --quiet
  # A branch per worktree. git refuses to check one branch out twice, which is
  # itself a useful guard against two sessions landing on the same branch.
  git -C "$main_root" worktree add -b "cowork/$name" "$dir" "$base"

  read -r api web <<<"$(ports_for "$name")"
  cat > "$dir/.env.cowork" <<EOF
# Ports for this worktree, so parallel dev servers don't collide.
# Loaded by api/package.json and web/vite.config.ts.
NCD_API_PORT=$api
NCD_WEB_PORT=$web
EOF
  # launch.json is a TRACKED file, so writing this tree's ports into it would
  # show up as a modification — and sooner or later someone commits it and
  # pushes one worktree's ports to everybody. skip-worktree makes THIS tree's
  # index ignore local changes to it (index state is per-worktree), so the file
  # is right for the preview tool and invisible to git.
  mkdir -p "$dir/.claude"
  cat > "$dir/.claude/launch.json" <<EOF
{
  "version": "0.0.1",
  "configurations": [
    { "name": "ncd-$name", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": $web }
  ]
}
EOF
  git -C "$dir" update-index --skip-worktree .claude/launch.json
  # Dependencies. Symlinking the whole node_modules would be the easy answer and
  # is WRONG: node_modules/@new-wealth/shared points at ../../packages/shared,
  # relative to the MAIN checkout — so a worktree editing packages/shared would
  # silently import and test the main checkout's copy instead of its own. Caught
  # the hard way: a statusMachine change appeared to do nothing, and a stale
  # `shared` build produced a phantom typecheck error in an untouched file.
  #
  # So: link the third-party packages (large, identical, safe to share) one by
  # one, then point the @new-wealth workspace packages at THIS tree.
  if [ -d "$main_root/node_modules" ]; then
    mkdir -p "$dir/node_modules"
    for entry in "$main_root/node_modules"/* "$main_root/node_modules"/.bin; do
      [ -e "$entry" ] || continue
      ln -sfn "$entry" "$dir/node_modules/$(basename "$entry")"
    done
    rm -rf "$dir/node_modules/@new-wealth"
    mkdir -p "$dir/node_modules/@new-wealth"
    ln -sfn "$dir/packages/shared" "$dir/node_modules/@new-wealth/shared"
    ln -sfn "$dir/api"             "$dir/node_modules/@new-wealth/api"
    ln -sfn "$dir/web"             "$dir/node_modules/@new-wealth/web"
    # A worktree starts with no build output, so the first import of `shared`
    # would resolve to a dist that does not exist yet.
    (cd "$dir" && npm run build -w @new-wealth/shared >/dev/null 2>&1) || true
  fi

  cmd_install_hooks >/dev/null
  cat <<EOF

  ready: $dir
    branch  cowork/$name  (from $base)
    api     :$api
    web     :$web

  cd "$dir"

EOF
}

cmd_list() {
  printf '%-16s %-34s %-7s %-7s %s\n' NAME BRANCH API WEB STATE
  git -C "$main_root" worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{b=$2; print w"\t"b}' |
  while IFS=$'\t' read -r dir branch; do
    local_name=$(basename "$dir")
    [ "$dir" = "$main_root" ] && local_name="(main checkout)"
    api=""; web=""
    [ -f "$dir/.env.cowork" ] && { api=$(sed -n 's/^NCD_API_PORT=//p' "$dir/.env.cowork"); web=$(sed -n 's/^NCD_WEB_PORT=//p' "$dir/.env.cowork"); }
    state="clean"
    if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then state="UNCOMMITTED"; fi
    ahead=$(git -C "$dir" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
    [ "$ahead" != "0" ] && state="$state, $ahead unpushed"
    printf '%-16s %-34s %-7s %-7s %s\n' "$local_name" "${branch#refs/heads/}" "${api:--}" "${web:--}" "$state"
  done
}

cmd_rm() {
  local name="${1:-}"; [ -z "$name" ] && { echo "usage: ops/cowork.sh rm <name>" >&2; exit 1; }
  local dir="$trees/$name"
  [ -d "$dir" ] || { echo "no such worktree: $dir" >&2; exit 1; }
  # Never discard work silently — that is the failure this whole thing exists to
  # prevent.
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    echo "refusing: $name has uncommitted changes. Commit, stash, or delete the directory by hand." >&2
    git -C "$dir" status --short >&2; exit 1
  fi
  # Commits that exist nowhere on the remote. Compare against the branch's own
  # upstream when it has one, and fall back to origin/main when it does not —
  # a branch that was never pushed HAS no upstream, and treating that as "zero
  # unpushed" would delete the work this check exists to protect.
  local base ahead
  base=$(git -C "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo 'origin/main')
  ahead=$(git -C "$dir" rev-list --count "$base..HEAD" 2>/dev/null || echo 0)
  if [ "$ahead" != "0" ]; then
    echo "refusing: $name has $ahead commit(s) not on $base. Push them first." >&2
    git -C "$dir" log --oneline "$base..HEAD" >&2; exit 1
  fi

  local branch
  branch=$(git -C "$dir" symbolic-ref --short HEAD 2>/dev/null || true)
  # A directory of symlinks now, not a single symlink — rm -f leaves it behind
  # and `git worktree remove` then refuses. Only the links go; the real
  # packages live in the main checkout and are untouched.
  rm -rf "$dir/node_modules"
  git -C "$main_root" worktree remove "$dir"
  # Remove the branch too, or `new` with the same name fails next time. Safe:
  # everything on it is already on the remote, checked above.
  if [ -n "$branch" ] && [ "$branch" != "main" ]; then
    git -C "$main_root" branch -D "$branch" >/dev/null 2>&1 && echo "removed $name (and branch $branch)" && return
  fi
  echo "removed $name"
}

case "${1:-}" in
  new) shift; cmd_new "$@";;
  list|ls) cmd_list;;
  rm|remove) shift; cmd_rm "$@";;
  install-hooks) cmd_install_hooks;;
  *) usage; exit 1;;
esac
