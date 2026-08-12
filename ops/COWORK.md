# Working in parallel without corrupting each other

Several Claude Code sessions run against this repository at once. This document
is the rule and the reason.

## The rule

**The main checkout (`~/tools/ncd`) is for pulling, reading and deploying. All
editing happens in a worktree.**

```bash
ops/cowork.sh new my-task      # isolated branch + working tree + dev ports
cd .claude/worktrees/my-task
```

A `pre-commit` hook enforces this: committing from the main checkout is refused,
with instructions. Nothing is staged or lost when it fires.

## Why — three real failures, all on 2026-08-12

A git checkout has exactly **one** branch, **one** index and **one** working
tree. Two sessions sharing a directory are not working in parallel; they are
editing one set of files and one staging area, taking turns without knowing it.

1. **Work merged under the wrong PR.** One session had files in the tree while
   another ran `git add`. Those files went to production inside
   [#291](https://github.com/saravanasuren/ncd/pull/291), whose message is about
   locker rent — it never mentions the user-login change it actually shipped.
   The PR that was *supposed* to carry that change (#290) was then empty.
   This had happened before, in #131.

2. **A commit landed on `main`.** A `git checkout -b` appeared to succeed but
   didn't stick, because another session moved `HEAD` in between. The commit went
   to local `main` instead of the feature branch. It was caught before being
   pushed. It would not have been obvious if it had.

3. **A dev server couldn't start.** Two sessions wanted `:3030`.

The first two are **silent**. Nothing errors, nothing warns; the history is
simply wrong afterwards, and you find out — if you ever do — when a PR turns out
to be empty or a change goes live under a description that doesn't mention it.
For a system that moves customer money, an audit trail that misattributes changes
is not a tidiness problem.

## What each worktree gets

| | Main checkout | Worktree |
|---|---|---|
| Branch, index, working tree | shared by every session | its own |
| Dev ports | 3030 / 5173 | its own, derived from the name |
| `node_modules` | real | symlink to the main one |
| Commits | **blocked by hook** | allowed |

Ports come from the name, so the same worktree always gets the same pair and
`.claude/launch.json` stays valid across restarts.

## Commands

```bash
ops/cowork.sh new <name> [base]   # base defaults to origin/main
ops/cowork.sh list                # branches, ports, uncommitted/unpushed state
ops/cowork.sh rm <name>           # refuses if it holds uncommitted or unpushed work
ops/cowork.sh install-hooks       # one-off; `new` does it for you
```

`install-hooks` copies `ops/githooks/*` into `.git/cowork-hooks/` and points
`core.hooksPath` at it absolutely. That is **local git config, not a tracked
file** — it does not travel with a clone, so run it once per machine.
`ops/cowork.sh new` runs it for you.

It deliberately does *not* set `core.hooksPath=ops/githooks`, which is the
obvious version and is a trap: that path resolves against whatever is checked
out, so on a checkout sitting on an older commit the hook silently does not
exist and git runs nothing — no warning. That was tried first, and a test commit
went straight onto `main` with the guard apparently installed. Under the git dir
it is shared by every worktree and survives any branch switch.

## If the hook blocks you

Your changes are still there — the hook runs before anything is written.

```bash
git stash
cd .claude/worktrees/<your-worktree>
git stash pop
```

For a deliberate one-off with no other session running:

```bash
NCD_ALLOW_ROOT_COMMIT=1 git commit ...
```

## Also fixed here

`npm run dev` used to background the API and run vite in the foreground, so
Ctrl-C killed vite and **orphaned the API**. The orphan kept holding its port and
serving stale code to whoever came next — which cost one session an afternoon
debugging a `shared` package that was never rebuilt, and blocked another with
`EADDRINUSE`. `ops/dev.sh` now stops both together and exits if either dies.
