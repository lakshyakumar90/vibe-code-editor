# Phase 4A — Server-Side Git Engine + Source Control Foundation
# Phase 4B — Remote Sync, Branches & History

> **Phase 4B does not implement push-remote UI beyond explicit Push, and
> never implements pull requests, reviews, merge, rebase, force push,
> cherry-pick, revert, or conflict-resolution UI.**

## Architecture

```text
GitHub remote
     │  (future phases only)
     ▼
Git repository — persistent server-side worktree (simple-git, local ops only)
     │
     ▼
saved IDE files (Postgres Project + File — the source of truth)
     │
     ├── Yjs / Monaco (collaboration layer, never the truth)
     └── WebContainer runtime mirror (ephemeral, never the truth)
```

## Git engine location

`apps/api/src/modules/git/git.engine.ts` — the ONLY module that touches the
`git` binary (via `simple-git@3.36.0`). Every method is a typed local-only
operation (status/diff/show/add/reset/checkout/commit/rev-parse/init/config/
remote-add). There is no raw command passthrough: `runGit(projectId, args)`
does not exist and must never be added.

## Persistent worktree location/config

`<GIT_STORAGE_ROOT>/<gitRepositoryId>/` (default `<cwd>/.git-worktrees/`,
gitignored). The directory name derives ONLY from the database id — never
from owner/repo/request params, so traversal is structurally impossible.
Survives browser refresh, WebContainer remount, reconnects, and request
boundaries. Multi-instance deployments need shared storage + a distributed
lock (see below); the lock in `git.lock.ts` is process-local by design.

## GitRepository ↔ Project relationship

`GitRepository` (1:1, cascade delete) records remote identity
(`owner/repo/fullName`), `defaultBranch/currentBranch`, `importedSha`, and
permission snapshots. Phase 4A adds `initializedAt` (set once bootstrap
commits the imported snapshot) and `lastVerifiedAt` (cheap liveness stamp).
No commit/branch/diff tables — git itself stores that.

`importedSha` rule: a 40–64 char hex SHA bootstraps normally with an
`Import <fullName>@<short>` snapshot commit (the commit is new; the message
references the GitHub revision it snapshots — never claims to BE it). A
branch-name fallback is resolved to the real HEAD via the requesting user's
GitHub token first; unresolvable ⇒ `GIT_BOOTSTRAP_FAILED` (recoverable).
Projects never imported from GitHub carry a null binding and initialize as
local-only repositories (`Initial commit`, no remote); the explicit
Initialize action creates that binding, while read paths keep reporting
`GIT_NOT_CONNECTED` until the user opts in.

## File ↔ worktree synchronization

- **File rows → worktree** (incremental, best-effort, never breaks saves):
  `fileService` create/update/delete/move hooks + AI-apply hook, via
  `git.sync.ts`. Only active for projects with an initialized GitRepository.
- **Worktree → File rows** (discard only): restore/checkout, then reconcile
  rows (update in place preserving ids, recreate rows restored from HEAD,
  delete rows for removed staged-new files), set `updatedByUserId` to the
  operator, then `file.tree.changed` + `file.content.changed` broadcasts so
  open editors converge through Yjs.
- Content parity is maintained by these write-through hooks; `ensure`
  verifies `.git` + resolvable HEAD (cheap), not full content hashes.

## Operation lock

`withProjectGitLock` — one mutating op per project (bootstrap/stage/
unstage/discard/commit); concurrent attempts get 409
`GIT_OPERATION_IN_PROGRESS`. Status/diff are pure reads and bypass it.
Process-local: Redis/distributed coordination required before scaling
horizontally.

## Dirty-editor policy

Three distinct states: editor (Yjs, in-memory) vs persisted File rows vs
worktree. Saves persist converged Yjs content; the worktree observes saves.
`discard` compares live server Y.Doc text against DB rows for affected
files and returns 409 `GIT_DIRTY_EDITOR_STATE` on mismatch; the UI also
checks local dirty state first. Known approximation: client keystrokes not
yet received by the server and LRU-evicted docs are invisible to the
server check — the acting client's local check is the backstop.

## Commit identity

`commitIdentityFor`: sanitized `req.user` name + verified email-shaped
address, else deterministic `user-<id>@vibe.local`. Repo-local git config
only; never global, never environment-controlled, never OAuth tokens.

## Phase 4B — remote authentication strategy

Remote operations authenticate per-process via `GIT_CONFIG_COUNT` /
`GIT_CONFIG_KEY_0=http.extraHeader` /
`GIT_CONFIG_VALUE_0=Authorization: Bearer <token>` (native git feature)
plus `GIT_TERMINAL_PROMPT=0`. Consequences, all asserted by tests:

- The token lives only in the spawned git child's environment, built from
  an allowlist (`SystemRoot`, `PATH`, …) plus the bearer entry — simple-git
  passes custom env *without* merging `process.env`, and merging all of it
  trips simple-git's env protections, hence the allowlist.
- Nothing is ever written to `.git/config` (tests assert no credential
  material in configs, URLs, responses, or thrown errors).
- Only `https://`, `file://`, and absolute local paths are contactable
  (`assertSafeRemoteUrl`); SSH/ext schemes are rejected (they could hang
  on prompts).
- The token source is always the requesting user's Better Auth Account
  (repo scope required); the browser is never asked for it and
  `GitRepository` stores no copy.
- Remote ops run under `withRemoteTimeout` (60s → `GIT_REMOTE_TIMEOUT`);
  on timeout the lock releases while the child may linger — git's own
  `index.lock` makes any overlap fail safely, never corrupt.

## Phase 4B — GitHub remote mapping

`GitRepository.owner/repo` define the single `origin`, derived exclusively as
`https://{trusted-host}/{owner}/{repo}.git` where the host comes from the
server-side `GIT_GITHUB_HOST` env (validated bare hostname, default
`github.com`). There is deliberately NO per-project URL field: accepting a
remote URL from the browser would turn Git transport into an SSRF-capable
network client. Every remote op verifies `remote.origin.url` matches
(normalized for case, trailing slash, `.git`) or stops with
`GIT_REMOTE_MISMATCH`. Only `origin` is ever fetched/pushed; no refspec,
remote-name, URL, or flag input exists anywhere in the API surface
(asserted by static tests).

## Phase 4B — importRoot semantics

`GitRepository.importRoot` (`""` = repo root, e.g. `"apps/web"` = monorepo
app, `NULL` = unknown legacy row) is the authoritative IDE↔git path
mapping, recorded at Phase 3 import. Pre-4B rows were backfilled to NULL —
never guessed — because a wrong `""` on a monorepo import would mis-map
(and potentially push) the wrong tree. Remote mutations (fetch/pull/push,
clone, migration) throw `GIT_IMPORT_ROOT_UNKNOWN` (409) on NULL rows until
re-import records a proven root; local reads/status/diff/commit keep working
with identity mapping. `getRemoteState` reports `importRootKnown` so the UI
can explain. The *effective* prefix additionally requires the clone marker
(`git config vibe.bootstrap=clone`): legacy synthetic worktrees keep 4A
identity mapping bit-for-bit. Status/diff/stage/discard/commit/history
translate through it; entries outside the scope are dropped (monorepo
siblings never leak into the IDE).

## Phase 4B — worktree strategy

- GitHub-backed + token available: full `git clone` (real history) with
  non-cone sparse checkout restricted to exactly `<importRoot>/` (cone mode
  would keep root-level files — wrong for scoping), then DB rows overlaid
  so post-import edits survive as uncommitted changes. No commit.
- Otherwise: the 4A synthetic snapshot path, unchanged.
- Synthetic→clone migration happens only on remote operations (never on
  reads), only for single-commit histories, only with clean editors;
  multi-commit synthetic histories refuse explicitly instead of hiding
  local commits.

## Phase 4B — fetch behavior

`fetch origin --prune`. Updates remote-tracking refs only — worktree, DB,
and current branch untouched. Returns branch/upstream/ahead/behind.

## Phase 4B — pull strategy

Fast-forward-only (`git merge --ff-only <upstream>`) after clean-editor +
clean-worktree guards. Diverged histories → `GIT_PULL_DIVERGED` (no merge
commits, no rebase, no conflicts UI). Up-to-date → clean no-op. On advance:
full worktree→DB reconcile + tree/content broadcasts.

## Phase 4B — push policy

Explicit user action only (never after commit). Requires project EDITOR+
(route), fresh GitHub `canWrite` re-check (snapshot updated, never trusted
blindly), and the fixed `origin` + explicit branch (defaults to current).
New branches get `--set-upstream` so later pulls work. Non-fast-forward →
`GIT_PUSH_REJECTED`; read-only token → `GIT_PUSH_DENIED` (403); no `--force`
flag exists anywhere in the call path (asserted by tests).

## Phase 4B — branch behavior

List local + `origin/*` remote-tracking branches with per-branch upstream
and ancestry counts. Create validates centrally (pure validator mirrored in
the UI + `git check-ref-format`), never checks out or pushes. Checkout
requires clean editor + clean worktree, supports `origin/x` → local
tracking branch creation, then fully reconciles into File rows (ids
preserved) with broadcasts and `currentBranch` persistence.

## Phase 4B — ahead/behind calculation

Always `git rev-list --left-right --count <local>...<upstream>` ancestry —
never timestamps or Postgres. Surfaced on status, branch lists, and
fetch/pull/push results.

## Phase 4B — dirty-state rules

Checkout/pull reuse the 4A live-Y.Doc-vs-DB comparison project-wide, plus
the acting client's local check. Strict clean-worktree requirement (any
entry, including untracked). No stash/commit/discard automation.

## Phase 4B — operation lock

Same reentrant per-project lock (fetch included — it mutates refs).
409 `GIT_OPERATION_IN_PROGRESS` on contention. Still process-local; Redis
needed before horizontal scale.

## Phase 4B — local-only repositories

No owner/repo → `LOCAL_ONLY`: branches/history/commit work, remote
endpoints report unavailability, no GitHub required anywhere.

## Phase 4B — remote failure behavior

`REAUTH_REQUIRED` (401, no/invalid token), `REMOTE_UNAVAILABLE` (404,
network, rate-limit, deleted repo — never distinguishing missing from
forbidden), `REMOTE_MISMATCH` (tampered origin), `REMOTE_TIMEOUT` (60s).
Local repo, branches, history, and File rows always stay usable.

## Phase 4B limitations

- Pull uses fast-forward-only semantics.
- Force push is not supported.
- Merge/rebase/cherry-pick/revert/conflict UI are not supported.
- History merges compare against their first parent.
- History cursor pagination assumes the cursor is on the requested branch.
- PR/review/merge functionality is not part of Phase 4B.

## Current limitations (4A)

- Local commits only; no push/pull/fetch/branches/PRs/history panel.
- Discard operates on files (not directories); untracked files are never
  discarded (delete explicitly).
- Status capped at 2000 entries (`truncated` flag, never false-clean);
  diffs capped at 256KB/side (`tooLarge` flag); binaries report
  `isBinary` without contents.
- Bootstrap rebuilds from DB rows when `.git` is missing or HEAD is
  unresolvable (worktree always mirrors DB, so nothing user-visible is
  lost — but uncommitted worktree-only state cannot exist by construction).
