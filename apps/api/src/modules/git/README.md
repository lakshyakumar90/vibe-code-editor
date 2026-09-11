# Phase 4A — Server-Side Git Engine + Source Control Foundation

> **Phase 4A does not implement remote push/pull/fetch.**

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
