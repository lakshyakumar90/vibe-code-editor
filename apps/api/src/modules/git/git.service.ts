import { prisma } from "@repo/db";
import { hasRepoScope } from "../github/github.service";
import { fetchRepoDetail } from "../github/repos.service";
import { GitError } from "./git.errors";
import {
  isCommitSha,
  isValidBranchName,
  normalizeBranchName,
  normalizeGitPath,
  normalizeGitPathList,
} from "./git.paths";
import { withProjectGitLock } from "./git.lock";
import { ensureStorageRoot, hasGitDir, removeWorktreeDir, worktreeDirFor } from "./git.store";
import {
  commitAllowEmpty,
  commitStaged,
  currentBranch,
  discardPaths,
  diffFile,
  ensureIdentity,
  getStatus,
  initRepo,
  revparseHead,
  stageAll,
  stagePaths,
  unstageAll,
  unstagePaths,
  type CommitIdentity,
  type EngineDiff,
  type EngineStatus,
} from "./git.engine";
import {
  aheadBehind,
  checkoutBranch,
  checkoutTracking,
  CLONE_MARKER_VALUE,
  cloneRepo,
  commitCount,
  commitFileChanges,
  commitMeta,
  createBranch,
  fetchOrigin,
  getCloneMarker,
  getRemoteUrl,
  getUpstream,
  gitAuthEnv,
  historyFileDiff,
  listBranches,
  logCommits,
  mergeFastForward,
  pushBranch,
  setCloneMarker,
  setSparseRoot,
  tryRevparse,
  validateBranchRef,
} from "./git.remote";
import {
  materializeProjectToDir,
  readWorktreeFiles,
  reconcileWorktreeToDb,
  toIdePath,
} from "./git.sync";
import { fileRepository } from "../projects/files/file.repository";
import { emitFileContentChanged, emitFileTreeChanged } from "../projects/files/file.events";
import { getActiveEditorService } from "../collab/collab.editor";

/**
 * Phase 4A — Git orchestration. Phase 4B adds remote sync, branches and
 * history below the "Phase 4B" marker.
 *
 * Data flow: Postgres File rows (truth) <-> persistent worktree (git) ->
 * normalized DTOs. Every mutating op runs under the per-project lock
 * (reentrant within one async chain). Tokens never persist: remote auth
 * travels only in per-process git env (see git.remote.ts).
 *
 * Path model: the UI speaks IDE-relative paths. The engine speaks git
 * paths (`<importRoot>/<idePath>`, identity when the effective root is
 * ""). The effective root is the stored importRoot ONLY for real clones
 * (clone marker); legacy synthetic worktrees keep 4A identity mapping.
 */

export const MAX_STATUS_ENTRIES = 2000;
export const MAX_HISTORY_LIMIT = 200;
export const DEFAULT_HISTORY_LIMIT = 50;

export interface GitStatusEntry {
  path: string;
  oldPath?: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted";
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatusDto {
  branch: string;
  /** Upstream of the current branch (`origin/main`), if configured. */
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  truncated: boolean;
  totalCount: number;
  entries: GitStatusEntry[];
  /** Present when the project has a GitHub binding (no capability implied). */
  remote: { owner: string; repo: string; fullName: string | null } | null;
}

export interface GitDiffDto {
  path: string;
  oldPath?: string;
  status: GitStatusEntry["status"];
  staged: boolean;
  isBinary: boolean;
  tooLarge: boolean;
  oldContent: string | null;
  newContent: string | null;
}

export interface GitCommitDto {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  changedFiles: string[];
}

export type RemoteCapability =
  | "LOCAL_ONLY"
  | "CONNECTED_READONLY"
  | "CONNECTED_WRITE"
  | "REMOTE_UNAVAILABLE"
  | "REAUTH_REQUIRED";

export interface RemoteStateDto {
  capability: RemoteCapability;
  remote: { owner: string; repo: string; fullName: string | null; url: string } | null;
  permissions: { canRead: boolean; canWrite: boolean; canAdmin: boolean } | null;
  /** False for legacy imports whose original root was never recorded. */
  importRootKnown: boolean;
}

export interface GitBranchDto {
  name: string;
  current: boolean;
  remote: boolean;
  remoteName?: string;
  commit: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
}

export interface BranchListDto {
  current: string;
  local: GitBranchDto[];
  remote: Array<{ name: string; remoteName: string; commit: string }>;
  remoteTruncated: boolean;
}

export interface FetchResultDto {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  fetchedAt: string;
}

export interface PullResultDto {
  pulled: boolean;
  oldSha: string | null;
  newSha: string | null;
  status: GitStatusDto;
  reconciled: { filesUpserted: number; filesDeleted: number };
}

export interface PushResultDto {
  branch: string;
  remote: string;
  pushed: boolean;
  oldSha: string | null;
  newSha: string | null;
  ahead: number;
  behind: number;
}

export interface HistoryCommitDto {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  parents: string[];
}

export interface HistoryDto {
  branch: string;
  commits: HistoryCommitDto[];
  hasMore: boolean;
}

export interface CommitDetailDto extends HistoryCommitDto {
  files: Array<{
    path: string;
    oldPath?: string;
    status: GitStatusEntry["status"];
    additions?: number;
    deletions?: number;
    binary: boolean;
  }>;
}

export interface HistoryDiffDto extends GitDiffDto {
  sha: string;
}

interface SessionUser {
  id: string;
  name?: string | null;
  email?: string | null;
}

function sanitizeIdentityPart(value: unknown, max: number, fallback: string): string {
  const cleaned = String(value ?? "")
    .replace(/[\r\n<>"]/g, "")
    .trim()
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Commit identity policy (documented in module README). */
export function commitIdentityFor(user: SessionUser): CommitIdentity {
  const name = sanitizeIdentityPart(user.name, 100, "User");
  const rawEmail = sanitizeIdentityPart(user.email, 254, "");
  const email =
    /^[^\s@]+@[^\s@]+$/.test(rawEmail) ? rawEmail : `user-${user.id}@vibe.local`;
  return { name, email };
}

/**
 * Effective IDE↔git path prefix: the stored importRoot applies ONLY to
 * real clones (clone marker). Legacy synthetic worktrees keep the 4A
 * identity mapping, so existing behavior is bit-identical.
 */
async function readPrefix(worktreeDir: string, importRoot: string | null | undefined): Promise<string> {
  const root = (importRoot ?? "").replace(/^\/+|\/+$/g, "");
  if (!root) return "";
  const marker = await getCloneMarker(worktreeDir).catch(() => null);
  return marker === CLONE_MARKER_VALUE ? root : "";
}

function toStatusDto(
  engine: EngineStatus,
  translated: GitStatusEntry[],
  extras: {
    upstream: string | null;
    ahead: number;
    behind: number;
    remote: GitStatusDto["remote"];
  },
): GitStatusDto {
  const totalCount = translated.length;
  const truncated = totalCount > MAX_STATUS_ENTRIES;
  const entries = truncated ? translated.slice(0, MAX_STATUS_ENTRIES) : translated;
  return {
    branch: engine.branch,
    upstream: extras.upstream,
    ahead: extras.ahead,
    behind: extras.behind,
    // Never report clean when entries were cut.
    clean: !truncated && engine.clean && translated.length === engine.entries.length,
    truncated,
    totalCount,
    entries,
    remote: extras.remote,
  };
}

function remotePresence(link: {
  owner: string | null;
  repo: string | null;
  fullName: string | null;
}): GitStatusDto["remote"] {
  if (!link.owner || !link.repo) return null;
  return { owner: link.owner, repo: link.repo, fullName: link.fullName };
}

/** Enriched status: importRoot translation + upstream/ahead-behind + remote. */
async function buildStatusDto(
  worktreeDir: string,
  link: { importRoot: string | null; owner: string | null; repo: string | null; fullName: string | null },
): Promise<GitStatusDto> {
  const engineStatus = await getStatus(worktreeDir);
  const prefix = await readPrefix(worktreeDir, link.importRoot);
  const translated: GitStatusEntry[] = [];
  for (const e of engineStatus.entries) {
    const ide = toIdePath(prefix, e.path);
    if (ide === null) continue; // Outside the import scope (monorepo rule).
    const oldIde = e.oldPath ? toIdePath(prefix, e.oldPath) : null;
    translated.push({
      path: ide,
      ...(oldIde ? { oldPath: oldIde } : {}),
      status: e.status,
      staged: e.staged,
      unstaged: e.unstaged,
    });
  }
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  try {
    upstream = await getUpstream(worktreeDir, engineStatus.branch);
    if (upstream) {
      const ab = await aheadBehind(worktreeDir, engineStatus.branch, upstream);
      ahead = ab.ahead;
      behind = ab.behind;
    }
  } catch {
    upstream = null;
    ahead = 0;
    behind = 0;
  }
  return toStatusDto(engineStatus, translated, {
    upstream,
    ahead,
    behind,
    remote: remotePresence(link),
  });
}

function toDiffDto(diff: EngineDiff, prefix: string): GitDiffDto {
  const ide = toIdePath(prefix, diff.path) ?? diff.path;
  const oldIde = diff.oldPath ? (toIdePath(prefix, diff.oldPath) ?? undefined) : undefined;
  return {
    path: ide,
    ...(oldIde ? { oldPath: oldIde } : {}),
    status: diff.status,
    staged: diff.staged,
    isBinary: diff.isBinary,
    tooLarge: diff.tooLarge,
    oldContent: diff.oldContent,
    newContent: diff.newContent,
  };
}

/** Server-side GitHub token (repo scope required). Never leaves the server. */
async function getGitHubToken(userId: string): Promise<string | null> {
  let account: { accessToken: string | null; scope: string | null } | null;
  try {
    account = await prisma.account.findFirst({
      where: { userId, providerId: "github" },
      select: { accessToken: true, scope: true },
    });
  } catch {
    return null;
  }
  if (!account?.accessToken || !hasRepoScope(account.scope)) return null;
  return account.accessToken;
}

/**
 * Phase 4B hardening: the ONLY trusted GitHub host configuration.
 * Server-side only (env), never derived from user input — the transport
 * layer must never become an arbitrary network client.
 */
export function getGitHubHost(): string {
  const raw = (process.env["GIT_GITHUB_HOST"] ?? "github.com").trim().toLowerCase();
  if (raw.length > 0 && raw.length <= 253 && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::\d+)?$/.test(raw)) {
    return raw;
  }
  return "github.com";
}

/**
 * Resolved remote URL: derived EXCLUSIVELY from validated owner/repo plus
 * the trusted host. There is no per-project URL override — accepting one
 * from the browser would turn Git transport into an SSRF-capable client.
 * Pure.
 */
export function resolveRemoteUrl(link: { owner: string | null; repo: string | null }): string | null {
  if (link.owner && link.repo) return `https://${getGitHubHost()}/${link.owner}/${link.repo}.git`;
  return null;
}

/**
 * Phase 4B hardening: refuse remote mutations when the original import
 * root was never recorded (pre-4B legacy rows backfilled to NULL).
 * Guessing "" would mis-map monorepo content and could push the wrong
 * tree to GitHub. Local reads/status/diff are unaffected.
 */
export function requireKnownImportRoot(link: { importRoot: string | null | undefined }): string {
  if (link.importRoot === null || link.importRoot === undefined) {
    throw new GitError(
      "GIT_IMPORT_ROOT_UNKNOWN",
      "This project's original import location is unknown (imported before location tracking). " +
        "Remote operations are disabled to protect the GitHub repository. " +
        "Re-import the repository to enable push, pull, and fetch.",
    );
  }
  return link.importRoot;
}

/** URL comparison tolerant to case, trailing slash, and `.git` suffix. Pure. */
export function normalizeGitUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

async function requireLink(projectId: string) {
  const link = await prisma.gitRepository.findUnique({ where: { projectId } });
  if (!link) {
    throw new GitError("GIT_NOT_CONNECTED", "Git is not configured for this project");
  }
  return link;
}

/** Resolve the actual GitHub HEAD when importedSha is a branch fallback. */
async function resolveGitHubHead(
  userId: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  let account: { accessToken: string | null; scope: string | null } | null;
  try {
    account = await prisma.account.findFirst({
      where: { userId, providerId: "github" },
      select: { accessToken: true, scope: true },
    });
  } catch {
    return null;
  }
  if (!account?.accessToken || !hasRepoScope(account.scope)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}?per_page=1`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${account.accessToken}`,
          "User-Agent": "vibe-code-editor",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ sha?: unknown }>;
    const sha = Array.isArray(data) ? data[0]?.sha : null;
    return typeof sha === "string" && isCommitSha(sha) ? sha : null;
  } catch {
    return null;
  }
}

export interface EnsureResult {
  worktreeDir: string;
  gitRepositoryId: string;
  bootstrapped: boolean;
  branch: string;
  head: string | null;
}

/**
 * Locate the worktree, lazily bootstrapping on first use (Phase 3 imports
 * predate Git). Never deletes user changes: rebuilds only when `.git` is
 * missing or HEAD is unresolvable, and the worktree always mirrors DB rows.
 */
export interface EnsureOptions {
  /**
   * When true (explicit Initialize action), a missing GitRepository binding
   * is created as a local-only repository instead of GIT_NOT_CONNECTED.
   * Read paths (status/diff) never auto-create: plain projects keep
   * showing "Git is not configured for this project" until the user opts in.
   */
  createLocalIfMissing?: boolean;
}

async function getOrCreateLocalLink(projectId: string) {
  const existing = await prisma.gitRepository.findUnique({ where: { projectId } });
  if (existing) return existing;
  try {
    return await prisma.gitRepository.create({
      data: {
        projectId,
        defaultBranch: "main",
        currentBranch: "main",
        // Local-only rows are genuinely repo-root scoped.
        importRoot: "",
      },
    });
  } catch (err) {
    // Concurrent Initialize race (projectId is @unique): reuse the winner.
    if (typeof (err as { code?: unknown })?.code === "string" && (err as { code: string }).code === "P2002") {
      const winner = await prisma.gitRepository.findUnique({ where: { projectId } });
      if (winner) return winner;
    }
    throw err;
  }
}

export async function ensureRepository(
  projectId: string,
  user: SessionUser,
  opts: EnsureOptions = {},
): Promise<EnsureResult> {
  let link = await prisma.gitRepository.findUnique({ where: { projectId } });
  if (!link) {
    if (!opts.createLocalIfMissing) {
      throw new GitError("GIT_NOT_CONNECTED", "Git is not configured for this project");
    }
    link = await getOrCreateLocalLink(projectId);
  }
  const dir = worktreeDirFor(link.id);
  const head = (await hasGitDir(dir)) ? await revparseHead(dir) : null;
  if (link.initializedAt && head) {
    try {
      await prisma.gitRepository.update({
        where: { id: link.id },
        data: { lastVerifiedAt: new Date() },
      });
    } catch {
      // Observability timestamp must never break Git flows.
    }
    return { worktreeDir: dir, gitRepositoryId: link.id, bootstrapped: false, branch: link.currentBranch, head };
  }
  // Bootstrap mutates: run under the project lock.
  return withProjectGitLock(projectId, "bootstrap", () =>
    bootstrapRepository(projectId, user, link, dir),
  );
}

interface BootstrapLink {
  id: string;
  owner: string | null;
  repo: string | null;
  fullName: string | null;
  defaultBranch: string;
  currentBranch: string;
  importedSha: string | null;
  importRoot: string | null;
  initializedAt: Date | null;
}

/**
 * Shared clone flow used by bootstrap-with-token and synthetic migration.
 * DB rows are overlaid afterwards so post-import user edits survive as
 * uncommitted changes. No commit.
 */
async function cloneFreshWorktree(args: {
  projectId: string;
  link: BootstrapLink;
  dir: string;
  branch: string;
  token: string;
}): Promise<{ branch: string; head: string | null }> {
  const { projectId, link, dir, token } = args;
  let branch = args.branch;
  const url = resolveRemoteUrl(link);
  if (!url) {
    throw new GitError("GIT_REMOTE_UNAVAILABLE", "No remote configured for this repository.");
  }
  // Defense in depth: cloning with an unproven root would mis-scope the
  // entire worktree (see requireKnownImportRoot callers).
  const importRoot = requireKnownImportRoot(link);
  await ensureStorageRoot();
  await removeWorktreeDir(dir);
  await cloneRepo(url, dir, gitAuthEnv(token));
  await setCloneMarker(dir);
  if (importRoot) {
    await setSparseRoot(dir, importRoot);
  }
  // Settle on the recorded branch (tracking when it only exists remotely).
  const actual = await currentBranch(dir).catch(() => branch);
  if (actual !== branch) {
    const branches = await listBranches(dir);
    const local = branches.some((b) => !b.remote && b.name === branch);
    const remote = branches.some((b) => b.remote && b.remoteName === `origin/${branch}`);
    if (local) {
      await checkoutBranch(dir, branch);
    } else if (remote) {
      await checkoutTracking(dir, branch, branch);
    } else {
      branch = await currentBranch(dir).catch(() => actual);
    }
  }
  // DB rows win over the fresh clone: post-import user edits survive as
  // uncommitted working-tree changes instead of being lost.
  await materializeProjectToDir(projectId, dir, importRoot);
  return { branch, head: await revparseHead(dir) };
}

async function bootstrapRepository(
  projectId: string,
  user: SessionUser,
  link: BootstrapLink,
  dir: string,
): Promise<EnsureResult> {
  // Imported-SHA rule: null means local-only (no GitHub association);
  // a real SHA bootstraps normally; a branch-name fallback is NEVER
  // treated as a commit SHA — resolve it first or fail recoverably.
  let importedSha: string | null = link.importedSha ?? null;
  if (importedSha !== null && !isCommitSha(importedSha)) {
    if (!link.owner || !link.repo) {
      throw new GitError(
        "GIT_BOOTSTRAP_FAILED",
        "Could not determine the imported revision. Re-import the repository and retry.",
      );
    }
    const resolved = await resolveGitHubHead(user.id, link.owner, link.repo, link.defaultBranch);
    if (!resolved) {
      throw new GitError(
        "GIT_BOOTSTRAP_FAILED",
        "Could not determine the imported GitHub revision. Reconnect GitHub with repository access and retry.",
      );
    }
    importedSha = resolved;
    try {
      await prisma.gitRepository.update({
        where: { id: link.id },
        data: { importedSha: resolved },
      });
    } catch (err) {
      console.error("[git:bootstrap] failed to persist resolved SHA", String(err).slice(0, 300));
      throw new GitError("GIT_BOOTSTRAP_FAILED", "Could not record the imported revision");
    }
  }

  const branch = normalizeBranchName(link.currentBranch || link.defaultBranch);
  const identity = commitIdentityFor(user);
  const importRoot = link.importRoot ?? "";
  const token = link.owner && link.repo ? await getGitHubToken(user.id) : null;
  // Unknown legacy root: fall back to the synthetic snapshot (local git
  // keeps working exactly as in 4A). Only remote operations are blocked —
  // cloning around an unproven root could mis-scope the whole worktree.
  const rootKnown = link.importRoot !== null && link.importRoot !== undefined;
  try {
    // Clone path (real history + remote refs) whenever GitHub credentials
    // are available; synthetic snapshot otherwise (local-only and offline).
    if (token && link.owner && link.repo && rootKnown) {
      const cloned = await cloneFreshWorktree({ projectId, link, dir, branch, token });
      if (!cloned.head) {
        throw new GitError("GIT_BOOTSTRAP_FAILED", "Repository initialization did not produce a HEAD commit");
      }
      await prisma.gitRepository.update({
        where: { id: link.id },
        data: { initializedAt: new Date(), lastVerifiedAt: new Date(), currentBranch: cloned.branch },
      });
      console.log(
        `[git:bootstrap] project=${projectId} branch=${cloned.branch} head=${cloned.head.slice(0, 7)} clone=true`,
      );
      return { worktreeDir: dir, gitRepositoryId: link.id, bootstrapped: true, branch: cloned.branch, head: cloned.head };
    }

    const short = importedSha ? importedSha.slice(0, 7) : null;
    // Local-only repos get a plain initial commit; imports reference the
    // GitHub revision they snapshot (without claiming to BE that commit).
    const initialMessage =
      link.fullName && short ? `Import ${link.fullName}@${short}` : "Initial commit";
    const remoteUrl = resolveRemoteUrl(link);
    await ensureStorageRoot();
    await removeWorktreeDir(dir);
    await initRepo(dir, branch, remoteUrl, identity);
    // Preferred strategy: materialize the imported File rows (already
    // scoped to the Phase 3 root) and commit the exact snapshot.
    await materializeProjectToDir(projectId, dir, importRoot);
    await stageAll(dir);
    const status = await getStatus(dir);
    if (status.entries.length === 0 && (await revparseHead(dir)) === null) {
      // Empty project: record initialization with an empty commit so HEAD
      // exists and later operations have a stable base.
      await ensureIdentity(dir, identity);
      await commitAllowEmpty(dir, initialMessage);
    } else {
      await commitStaged(dir, initialMessage, identity);
    }
    const head = await revparseHead(dir);
    if (!head) {
      throw new GitError("GIT_BOOTSTRAP_FAILED", "Repository initialization did not produce a HEAD commit");
    }
    await prisma.gitRepository.update({
      where: { id: link.id },
      data: { initializedAt: new Date(), lastVerifiedAt: new Date(), currentBranch: branch },
    });
    console.log(
      `[git:bootstrap] project=${projectId} branch=${branch} head=${head?.slice(0, 7)} importedSha=${short ?? "local"}`,
    );
    return { worktreeDir: dir, gitRepositoryId: link.id, bootstrapped: true, branch, head };
  } catch (err) {
    if (err instanceof GitError) throw err;
    console.error("[git:bootstrap] failed", String(err).slice(0, 500));
    throw new GitError("GIT_BOOTSTRAP_FAILED", "Could not initialize the Git repository for this project");
  }
}

// -- reads -------------------------------------------------------------------

export async function getProjectStatus(projectId: string, user: SessionUser): Promise<GitStatusDto> {
  const ensured = await ensureRepository(projectId, user);
  const link = await requireLink(projectId);
  return buildStatusDto(ensured.worktreeDir, link);
}

export async function getProjectDiff(
  projectId: string,
  user: SessionUser,
  repoPath: string,
  staged: boolean,
): Promise<GitDiffDto> {
  const ensured = await ensureRepository(projectId, user);
  const link = await requireLink(projectId);
  const prefix = await readPrefix(ensured.worktreeDir, link.importRoot);
  const normalized = normalizeGitPath(repoPath);
  const gitPath = prefix === "" ? normalized : `${prefix}/${normalized}`;
  return toDiffDto(await diffFile(ensured.worktreeDir, gitPath, staged), prefix);
}

// -- mutations -----------------------------------------------------------------

export async function stageProjectPaths(
  projectId: string,
  user: SessionUser,
  paths: string[],
): Promise<GitStatusDto> {
  const normalized = normalizeGitPathList(paths);
  if (normalized.length === 0) {
    throw new GitError("GIT_INVALID_PATH", "Select at least one file to stage");
  }
  return withProjectGitLock(projectId, "stage", async () => {
    const ensured = await ensureRepository(projectId, user);
    const link = await requireLink(projectId);
    const prefix = await readPrefix(ensured.worktreeDir, link.importRoot);
    const before = await buildStatusDto(ensured.worktreeDir, link);
    const known = new Set(before.entries.map((e) => e.path));
    for (const p of normalized) {
      if (!known.has(p)) {
        throw new GitError("GIT_INVALID_PATH", `File has no Git changes: ${p}`);
      }
    }
    await stagePaths(
      ensured.worktreeDir,
      normalized.map((p) => (prefix === "" ? p : `${prefix}/${p}`)),
    );
    return buildStatusDto(ensured.worktreeDir, link);
  });
}

export async function unstageProjectPaths(
  projectId: string,
  user: SessionUser,
  paths: string[],
): Promise<GitStatusDto> {
  const normalized = normalizeGitPathList(paths);
  if (normalized.length === 0) {
    throw new GitError("GIT_INVALID_PATH", "Select at least one file to unstage");
  }
  return withProjectGitLock(projectId, "unstage", async () => {
    const ensured = await ensureRepository(projectId, user);
    const link = await requireLink(projectId);
    const prefix = await readPrefix(ensured.worktreeDir, link.importRoot);
    const before = await buildStatusDto(ensured.worktreeDir, link);
    const known = new Set(before.entries.map((e) => e.path));
    for (const p of normalized) {
      if (!known.has(p)) {
        throw new GitError("GIT_INVALID_PATH", `File has no Git changes: ${p}`);
      }
    }
    await unstagePaths(
      ensured.worktreeDir,
      normalized.map((p) => (prefix === "" ? p : `${prefix}/${p}`)),
    );
    return buildStatusDto(ensured.worktreeDir, link);
  });
}

export async function stageAllPaths(projectId: string, user: SessionUser): Promise<GitStatusDto> {
  return withProjectGitLock(projectId, "stage-all", async () => {
    const ensured = await ensureRepository(projectId, user);
    const link = await requireLink(projectId);
    await stageAll(ensured.worktreeDir);
    return buildStatusDto(ensured.worktreeDir, link);
  });
}

export async function unstageAllPaths(projectId: string, user: SessionUser): Promise<GitStatusDto> {
  return withProjectGitLock(projectId, "unstage-all", async () => {
    const ensured = await ensureRepository(projectId, user);
    const link = await requireLink(projectId);
    await unstageAll(ensured.worktreeDir);
    return buildStatusDto(ensured.worktreeDir, link);
  });
}

/**
 * Compare live Y.Doc text against persisted rows for the dirty-editor
 * guard. Absent server docs count as clean (acting client's local check
 * is the backstop for in-flight keystrokes).
 */
async function findUnsavedPaths(projectId: string, repoPaths: string[]): Promise<string[]> {
  const service = getActiveEditorService();
  if (!service) return [];
  const dirty: string[] = [];
  for (const repoPath of repoPaths.slice(0, 500)) {
    const row = await fileRepository
      .getFileByPath(projectId, repoPath)
      .catch(() => null);
    if (!row || row.isFolder) continue;
    const live = service.getDocText(projectId, row.id);
    if (live !== null && live !== (row.content ?? "")) {
      dirty.push(repoPath);
    }
  }
  return dirty;
}

/** Project-wide unsaved check (checkout/pull guards). Bounded by repo size. */
async function findAllUnsavedPaths(projectId: string): Promise<string[]> {
  const service = getActiveEditorService();
  if (!service) return [];
  const rows = await prisma.file.findMany({
    where: { projectId, isFolder: false },
    select: { id: true, path: true, content: true },
  });
  const dirty: string[] = [];
  for (const row of rows) {
    let live: string | null;
    try {
      live = service.getDocText(projectId, row.id);
    } catch {
      continue;
    }
    if (live !== null && live !== (row.content ?? "")) {
      dirty.push(row.path);
    }
  }
  return dirty;
}

async function ensureFolderRow(projectId: string, dirPath: string, userId: string): Promise<string | null> {
  if (!dirPath) return null;
  const existing = await fileRepository.getFileByPath(projectId, dirPath).catch(() => null);
  if (existing) return existing.id;
  const parent = dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : null;
  const parentId = parent ? await ensureFolderRow(projectId, parent, userId) : null;
  const created = await fileRepository.createFile({
    projectId,
    name: dirPath.split("/").pop() ?? dirPath,
    content: null,
    parentId,
    isFolder: true,
    path: dirPath,
    updatedByUserId: userId,
  });
  return created.id;
}

export interface DiscardResultDto {
  restored: string[];
  removed: string[];
  status: GitStatusDto;
}

export async function discardProjectPaths(
  projectId: string,
  user: SessionUser,
  paths: string[],
): Promise<DiscardResultDto> {
  const normalized = normalizeGitPathList(paths);
  if (normalized.length === 0) {
    throw new GitError("GIT_INVALID_PATH", "Select at least one file to discard");
  }
  return withProjectGitLock(projectId, "discard", async () => {
    const ensured = await ensureRepository(projectId, user);
    const link = await requireLink(projectId);
    const prefix = await readPrefix(ensured.worktreeDir, link.importRoot);
    const toGit = (ide: string): string => (prefix === "" ? ide : `${prefix}/${ide}`);
    const before = await buildStatusDto(ensured.worktreeDir, link);
    const byPath = new Map(before.entries.map((e) => [e.path, e]));
    for (const p of normalized) {
      const entry = byPath.get(p);
      if (!entry) {
        throw new GitError("GIT_INVALID_PATH", `File has no Git changes: ${p}`);
      }
      if (entry.status === "untracked") {
        throw new GitError(
          "GIT_INVALID_PATH",
          `Untracked file "${p}" cannot be discarded — delete it explicitly`,
        );
      }
    }
    // Dirty-editor guard: never silently clobber in-memory edits.
    const unsaved = await findUnsavedPaths(projectId, normalized);
    if (unsaved.length > 0) {
      throw new GitError(
        "GIT_DIRTY_EDITOR_STATE",
        "Save open editors before discarding",
        { paths: unsaved },
      );
    }
    const results = await discardPaths(ensured.worktreeDir, normalized.map(toGit));

    // Reconcile worktree -> File rows (preserve ids where possible).
    const restored: string[] = [];
    const removed: string[] = [];
    const changedFileIds: string[] = [];
    for (const r of results) {
      const idePath = toIdePath(prefix, r.path) ?? r.path;
      if (r.outcome === "restored") {
        const reads = await readWorktreeFiles(ensured.worktreeDir, [r.path]);
        const read = reads[0];
        if (read && !read.missing && read.content !== null) {
          const existing = await fileRepository.getFileByPath(projectId, idePath).catch(() => null);
          if (existing) {
            await fileRepository.updateFile(existing.id, projectId, {
              content: read.content,
              updatedByUserId: user.id,
            });
            changedFileIds.push(existing.id);
          } else {
            const parent = idePath.includes("/") ? idePath.slice(0, idePath.lastIndexOf("/")) : null;
            const parentId = parent ? await ensureFolderRow(projectId, parent, user.id) : null;
            const created = await fileRepository.createFile({
              projectId,
              name: idePath.split("/").pop() ?? idePath,
              content: read.content,
              parentId,
              isFolder: false,
              path: idePath,
              updatedByUserId: user.id,
            });
            changedFileIds.push(created.id);
          }
          restored.push(idePath);
        } else {
          // Restored entry vanished (e.g. directory edge) — drop the row.
          const existing = await fileRepository.getFileByPath(projectId, idePath).catch(() => null);
          if (existing && !existing.isFolder) {
            await fileRepository.deleteFile(existing.id, projectId);
            removed.push(idePath);
          }
        }
      } else if (r.outcome === "removed") {
        const existing = await fileRepository.getFileByPath(projectId, idePath).catch(() => null);
        if (existing) {
          await fileRepository.deleteFile(existing.id, projectId);
          removed.push(idePath);
        }
      }
    }
    emitFileTreeChanged(projectId);
    if (changedFileIds.length > 0) {
      emitFileContentChanged(projectId, changedFileIds);
    }
    const status = await buildStatusDto(ensured.worktreeDir, link);
    try {
      const branch = await currentBranch(ensured.worktreeDir);
      return { restored, removed, status: { ...status, branch } };
    } catch {
      return { restored, removed, status };
    }
  });
}

export interface CommitResultDto {
  commit: {
    sha: string;
    message: string;
    authorName: string;
    authorEmail: string;
    timestamp: string;
    changedFiles: string[];
  };
  status: GitStatusDto;
}

export async function commitProject(
  projectId: string,
  user: SessionUser,
  message: string,
): Promise<CommitResultDto> {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new GitError("GIT_COMMIT_INVALID_MESSAGE", "Commit message must not be empty");
  }
  if (message.trim().length > 2000) {
    throw new GitError("GIT_COMMIT_INVALID_MESSAGE", "Commit message must be at most 2000 characters");
  }
  return withProjectGitLock(projectId, "commit", async () => {
    const ensured = await ensureRepository(projectId, user);
    const link = await requireLink(projectId);
    const before = await buildStatusDto(ensured.worktreeDir, link);
    const stagedPaths = before.entries.filter((e) => e.staged).map((e) => e.path);
    if (stagedPaths.length === 0) {
      throw new GitError("GIT_NO_CHANGES", "There are no staged changes to commit");
    }
    const identity = commitIdentityFor(user);
    await ensureIdentity(ensured.worktreeDir, identity);
    const result = await commitStaged(ensured.worktreeDir, message, identity);
    try {
      await prisma.gitRepository.update({
        where: { id: ensured.gitRepositoryId },
        data: { lastVerifiedAt: new Date() },
      });
    } catch {
      // Observability timestamp must never break the commit response.
    }
    return {
      commit: {
        sha: result.sha,
        message: result.message,
        authorName: result.authorName,
        authorEmail: result.authorEmail,
        timestamp: result.timestamp,
        changedFiles: stagedPaths,
      },
      status: await buildStatusDto(ensured.worktreeDir, link),
    };
  });
}

// -- Phase 4B: remote, branches, history ---------------------------------------

/**
 * Upgrade a synthetic worktree to a real clone when GitHub credentials are
 * available. Safe by construction: the server worktree always mirrors DB
 * rows, so rebuilding + re-applying DB rows loses nothing except the
 * synthetic initial commit. Multi-commit synthetic histories are refused
 * explicitly (local commits would be hidden, never silently dropped).
 * Caller must hold the project lock.
 */
async function ensureGitHubClone(
  projectId: string,
  user: SessionUser,
  link: Awaited<ReturnType<typeof requireLink>>,
  dir: string,
): Promise<{ migrated: boolean }> {
  const marker = await getCloneMarker(dir).catch(() => null);
  if (marker === CLONE_MARKER_VALUE) return { migrated: false };
  // Structural blocker first: never rebuild around an unproven root.
  requireKnownImportRoot(link);
  const token = await getGitHubToken(user.id);
  if (!token) {
    throw new GitError(
      "GIT_GITHUB_REAUTH_REQUIRED",
      "GitHub authentication is required for remote operations. Reconnect GitHub and retry.",
    );
  }
  if (!link.owner || !link.repo) {
    throw new GitError("GIT_REMOTE_UNAVAILABLE", "No remote configured for this repository.");
  }
  const count = await commitCount(dir);
  if (count === null) {
    throw new GitError("GIT_BOOTSTRAP_FAILED", "Local repository state is unreadable. Re-initialize and retry.");
  }
  if (count > 1) {
    throw new GitError(
      "GIT_BOOTSTRAP_FAILED",
      "This project has local commits on a history that is not connected to GitHub. " +
        "Remote sync needs a fresh clone, which would hide that local history. " +
        "Export or note your commits, then re-initialize the repository.",
    );
  }
  const unsaved = await findAllUnsavedPaths(projectId);
  if (unsaved.length > 0) {
    throw new GitError("GIT_DIRTY_EDITOR_STATE", "Save open editors before synchronizing with the remote", {
      paths: unsaved.slice(0, 10),
      total: unsaved.length,
    });
  }
  const branch = normalizeBranchName(link.currentBranch || link.defaultBranch || "main");
  const cloned = await cloneFreshWorktree({ projectId, link, dir, branch, token });
  await prisma.gitRepository.update({
    where: { id: link.id },
    data: { lastVerifiedAt: new Date(), currentBranch: cloned.branch },
  }).catch(() => null);
  console.log(`[git:migrate] project=${projectId} synthetic→clone branch=${cloned.branch}`);
  return { migrated: true };
}

interface RemoteVerify {
  link: Awaited<ReturnType<typeof requireLink>>;
  dir: string;
  token: string;
  url: string;
}

/**
 * Verify the configured origin against GitRepository + GitHub API state.
 * Refreshes the permission snapshot (cache, never authority for the final
 * push decision — push re-checks). Throws stable errors; never leaks
 * repository existence (404 and forbidden both read as unavailable).
 */
async function verifyRemoteOrThrow(
  projectId: string,
  user: SessionUser,
  opts: { requireWrite?: boolean } = {},
): Promise<RemoteVerify> {
  const link = await requireLink(projectId);
  if (!link.owner || !link.repo) {
    throw new GitError("GIT_REMOTE_UNAVAILABLE", "No remote configured for this repository.");
  }
  const token = await getGitHubToken(user.id);
  if (!token) {
    throw new GitError(
      "GIT_GITHUB_REAUTH_REQUIRED",
      "GitHub authentication is required for remote operations. Reconnect GitHub and retry.",
    );
  }
  const url = resolveRemoteUrl(link);
  if (!url) {
    throw new GitError("GIT_REMOTE_UNAVAILABLE", "No remote configured for this repository.");
  }
  const detail = await fetchRepoDetail(token, link.owner, link.repo);
  if (detail.error || !detail.repo) {
    const status = detail.error?.status ?? 0;
    if (status === 404) {
      throw new GitError("GIT_REMOTE_UNAVAILABLE", "GitHub repository is unavailable.");
    }
    if (status === 401 || status === 403) {
      throw new GitError(
        "GIT_GITHUB_REAUTH_REQUIRED",
        "GitHub authentication is required for remote operations. Reconnect GitHub and retry.",
      );
    }
    if (detail.error?.rateLimited) {
      throw new GitError("GIT_REMOTE_UNAVAILABLE", "GitHub rate limit reached. Try again shortly.");
    }
    throw new GitError("GIT_REMOTE_UNAVAILABLE", "Could not reach GitHub. Try again shortly.");
  }
  const access = detail.repo.access;
  try {
    await prisma.gitRepository.update({
      where: { id: link.id },
      data: { canRead: access.canRead, canWrite: access.canWrite, canAdmin: access.canAdmin },
    });
  } catch {
    // Snapshot metadata must never break remote flows.
  }
  if (opts.requireWrite && !access.canWrite) {
    throw new GitError(
      "GIT_PUSH_DENIED",
      "GitHub denied push permission for this account. Push requires write access to the repository.",
    );
  }
  const dir = worktreeDirFor(link.id);
  if (await hasGitDir(dir)) {
    const actual = await getRemoteUrl(dir);
    if (actual && normalizeGitUrl(actual) !== normalizeGitUrl(url)) {
      throw new GitError(
        "GIT_REMOTE_MISMATCH",
        "The configured remote does not match this project. Remote operations are stopped.",
      );
    }
  }
  return { link, dir, token, url };
}

export async function getRemoteState(projectId: string, user: SessionUser): Promise<RemoteStateDto> {
  const link = await requireLink(projectId);
  const importRootKnown = link.importRoot !== null && link.importRoot !== undefined;
  if (!link.owner || !link.repo) {
    return { capability: "LOCAL_ONLY", remote: null, permissions: null, importRootKnown };
  }
  const url = resolveRemoteUrl(link);
  const remote = { owner: link.owner, repo: link.repo, fullName: link.fullName, url: url ?? "" };
  const token = await getGitHubToken(user.id);
  if (!token) {
    return {
      capability: "REAUTH_REQUIRED",
      remote,
      permissions: { canRead: link.canRead, canWrite: link.canWrite, canAdmin: link.canAdmin },
      importRootKnown,
    };
  }
  const detail = await fetchRepoDetail(token, link.owner, link.repo);
  if (detail.error || !detail.repo) {
    const status = detail.error?.status ?? 0;
    if (status === 401 || status === 403) {
      return { capability: "REAUTH_REQUIRED", remote, permissions: null, importRootKnown };
    }
    if (detail.error?.rateLimited) {
      throw new GitError("GIT_REMOTE_UNAVAILABLE", "GitHub rate limit reached. Try again shortly.");
    }
    return { capability: "REMOTE_UNAVAILABLE", remote, permissions: null, importRootKnown };
  }
  const dir = worktreeDirFor(link.id);
  if (await hasGitDir(dir)) {
    const actual = await getRemoteUrl(dir);
    if (actual && normalizeGitUrl(actual) !== normalizeGitUrl(url ?? "")) {
      throw new GitError(
        "GIT_REMOTE_MISMATCH",
        "The configured remote does not match this project. Remote operations are stopped.",
      );
    }
  }
  const access = detail.repo.access;
  try {
    await prisma.gitRepository.update({
      where: { id: link.id },
      data: { canRead: access.canRead, canWrite: access.canWrite, canAdmin: access.canAdmin },
    });
  } catch {
    // Snapshot metadata must never break reads.
  }
  return {
    capability: access.canWrite ? "CONNECTED_WRITE" : "CONNECTED_READONLY",
    remote,
    permissions: { canRead: access.canRead, canWrite: access.canWrite, canAdmin: access.canAdmin },
    importRootKnown,
  };
}

async function branchSummary(
  dir: string,
): Promise<{ current: string; local: GitBranchDto[]; remote: Array<{ name: string; remoteName: string; commit: string }>; remoteTruncated: boolean }> {
  const all = await listBranches(dir);
  const local: GitBranchDto[] = [];
  const remote: Array<{ name: string; remoteName: string; commit: string }> = [];
  for (const b of all) {
    if (b.remote) {
      if (remote.length < 500) {
        remote.push({ name: b.name, remoteName: b.remoteName ?? b.name, commit: b.commit });
      }
      continue;
    }
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    try {
      upstream = await getUpstream(dir, b.name);
      if (upstream) {
        const ab = await aheadBehind(dir, b.name, upstream);
        ahead = ab.ahead;
        behind = ab.behind;
      }
    } catch {
      upstream = null;
    }
    local.push({ name: b.name, current: b.current, remote: false, commit: b.commit, upstream, ahead, behind });
  }
  const current = local.find((b) => b.current)?.name ?? (await currentBranch(dir).catch(() => "HEAD"));
  return { current, local, remote, remoteTruncated: all.filter((b) => b.remote).length > remote.length };
}

export async function listProjectBranches(projectId: string, user: SessionUser): Promise<BranchListDto> {
  const ensured = await ensureRepository(projectId, user);
  const summary = await branchSummary(ensured.worktreeDir);
  return {
    current: summary.current,
    local: summary.local,
    remote: summary.remote,
    remoteTruncated: summary.remoteTruncated,
  };
}

export async function createProjectBranch(
  projectId: string,
  user: SessionUser,
  name: string,
  from?: string,
): Promise<{ branch: GitBranchDto; from: string }> {
  if (!isValidBranchName(name)) {
    throw new GitError("GIT_INVALID_BRANCH", `Invalid branch name: ${name}`);
  }
  const start = from && from.length > 0 ? from : "HEAD";
  if (start !== "HEAD" && !isValidBranchName(start)) {
    throw new GitError("GIT_INVALID_BRANCH", `Invalid branch start point: ${start}`);
  }
  return withProjectGitLock(projectId, "create-branch", async () => {
    const ensured = await ensureRepository(projectId, user);
    const branches = await listBranches(ensured.worktreeDir);
    if (branches.some((b) => !b.remote && b.name === name)) {
      throw new GitError("GIT_BRANCH_EXISTS", `Branch "${name}" already exists`);
    }
    await validateBranchRef(ensured.worktreeDir, name);
    let startPoint = "HEAD";
    if (start !== "HEAD") {
      const localHit = branches.some((b) => !b.remote && b.name === start);
      const remoteHit = branches.some((b) => b.remote && b.remoteName === `origin/${start}`);
      if (!localHit && !remoteHit) {
        throw new GitError("GIT_BRANCH_NOT_FOUND", `Start point "${start}" does not exist`);
      }
      startPoint = localHit ? start : `origin/${start}`;
    }
    await createBranch(ensured.worktreeDir, name, startPoint);
    return {
      branch: { name, current: false, remote: false, commit: (await tryRevparse(ensured.worktreeDir, name)) ?? "", upstream: null, ahead: 0, behind: 0 },
      from: startPoint,
    };
  });
}

async function reconcileAndBroadcast(
  projectId: string,
  dir: string,
  importRoot: string,
  userId: string,
): Promise<{ filesUpserted: number; filesDeleted: number; changedFileIds: string[] }> {
  const result = await reconcileWorktreeToDb(projectId, dir, importRoot, userId);
  emitFileTreeChanged(projectId);
  if (result.changedFileIds.length > 0) {
    emitFileContentChanged(projectId, result.changedFileIds);
  }
  return result;
}

export async function checkoutProjectBranch(
  projectId: string,
  user: SessionUser,
  target: string,
): Promise<{ branch: string; status: GitStatusDto; reconciled: { filesUpserted: number; filesDeleted: number } }> {
  if (!isValidBranchName(target)) {
    throw new GitError("GIT_INVALID_BRANCH", `Invalid branch name: ${target}`);
  }
  return withProjectGitLock(projectId, "checkout", async () => {
    const ensured = await ensureRepository(projectId, user);
    const link = await requireLink(projectId);
    const prefix = await readPrefix(ensured.worktreeDir, link.importRoot);
    const branches = await listBranches(ensured.worktreeDir);
    const remoteShort = target.startsWith("origin/") ? target.slice("origin/".length) : target;
    if (!isValidBranchName(remoteShort) || remoteShort.length === 0) {
      throw new GitError("GIT_INVALID_BRANCH", `Invalid branch name: ${target}`);
    }
    const hasLocal = branches.some((b) => !b.remote && b.name === remoteShort);
    const hasRemote = branches.some((b) => b.remote && b.remoteName === `origin/${remoteShort}`);
    if (!hasLocal && !hasRemote) {
      throw new GitError("GIT_BRANCH_NOT_FOUND", `Branch "${target}" does not exist`);
    }
    const unsaved = await findAllUnsavedPaths(projectId);
    if (unsaved.length > 0) {
      throw new GitError("GIT_DIRTY_EDITOR_STATE", "Save open editors before switching branches", {
        paths: unsaved.slice(0, 10),
        total: unsaved.length,
      });
    }
    const before = await getStatus(ensured.worktreeDir);
    if (before.entries.length > 0) {
      throw new GitError(
        "GIT_DIRTY_WORKTREE",
        "Working tree has local changes. Commit or discard them before switching branches.",
        { count: before.entries.length },
      );
    }
    await validateBranchRef(ensured.worktreeDir, remoteShort);
    if (!hasLocal && hasRemote) {
      await checkoutTracking(ensured.worktreeDir, remoteShort, remoteShort);
    } else {
      await checkoutBranch(ensured.worktreeDir, remoteShort);
    }
    try {
      await prisma.gitRepository.update({
        where: { id: link.id },
        data: { currentBranch: remoteShort, lastVerifiedAt: new Date() },
      });
    } catch {
      // Metadata must never break the checkout response.
    }
    const reconciled = await reconcileAndBroadcast(projectId, ensured.worktreeDir, prefix, user.id);
    const status = await buildStatusDto(ensured.worktreeDir, link);
    return {
      branch: remoteShort,
      status,
      reconciled: { filesUpserted: reconciled.filesUpserted, filesDeleted: reconciled.filesDeleted },
    };
  });
}

export async function fetchRemote(projectId: string, user: SessionUser): Promise<FetchResultDto> {
  return withProjectGitLock(projectId, "fetch", async () => {
    const link = await requireLink(projectId);
    requireKnownImportRoot(link);
    const token = await getGitHubToken(user.id);
    if (!token) {
      throw new GitError(
        "GIT_GITHUB_REAUTH_REQUIRED",
        "GitHub authentication is required for remote operations. Reconnect GitHub and retry.",
      );
    }
    const ensured = await ensureRepository(projectId, user);
    const fresh = await requireLink(projectId);
    await ensureGitHubClone(projectId, user, fresh, ensured.worktreeDir);
    await verifyRemoteOrThrow(projectId, user);
    await fetchOrigin(ensured.worktreeDir, gitAuthEnv(token));
    const branch = await currentBranch(ensured.worktreeDir);
    const upstream = await getUpstream(ensured.worktreeDir, branch).catch(() => null);
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      try {
        const ab = await aheadBehind(ensured.worktreeDir, branch, upstream);
        ahead = ab.ahead;
        behind = ab.behind;
      } catch {
        ahead = 0;
        behind = 0;
      }
    }
    try {
      await prisma.gitRepository.update({
        where: { id: fresh.id },
        data: { lastVerifiedAt: new Date() },
      });
    } catch {
      // Observability only.
    }
    return { branch, upstream, ahead, behind, fetchedAt: new Date().toISOString() };
  });
}

export async function pullProject(projectId: string, user: SessionUser): Promise<PullResultDto> {
  return withProjectGitLock(projectId, "pull", async () => {
    const link = await requireLink(projectId);
    requireKnownImportRoot(link);
    const token = await getGitHubToken(user.id);
    if (!token) {
      throw new GitError(
        "GIT_GITHUB_REAUTH_REQUIRED",
        "GitHub authentication is required for remote operations. Reconnect GitHub and retry.",
      );
    }
    const ensured = await ensureRepository(projectId, user);
    const fresh = await requireLink(projectId);
    await ensureGitHubClone(projectId, user, fresh, ensured.worktreeDir);
    await verifyRemoteOrThrow(projectId, user);
    const prefix = await readPrefix(ensured.worktreeDir, fresh.importRoot);
    const branch = await currentBranch(ensured.worktreeDir);
    const upstream = await getUpstream(ensured.worktreeDir, branch).catch(() => null);
    if (!upstream) {
      throw new GitError(
        "GIT_NO_UPSTREAM",
        `Branch "${branch}" has no upstream configured. Fetch is still available.`,
      );
    }
    const unsaved = await findAllUnsavedPaths(projectId);
    if (unsaved.length > 0) {
      throw new GitError("GIT_DIRTY_EDITOR_STATE", "Save open editors before pulling", {
        paths: unsaved.slice(0, 10),
        total: unsaved.length,
      });
    }
    const dirty = await getStatus(ensured.worktreeDir);
    if (dirty.entries.length > 0) {
      throw new GitError(
        "GIT_DIRTY_WORKTREE",
        "Working tree has local changes. Commit or discard them before pulling.",
        { count: dirty.entries.length },
      );
    }
    const oldSha = await tryRevparse(ensured.worktreeDir, "HEAD");
    await fetchOrigin(ensured.worktreeDir, gitAuthEnv(token));
    const merged = await mergeFastForward(ensured.worktreeDir, upstream);
    const newSha = await tryRevparse(ensured.worktreeDir, "HEAD");
    let reconciled = { filesUpserted: 0, filesDeleted: 0, changedFileIds: [] as string[] };
    if (merged.updated) {
      reconciled = await reconcileAndBroadcast(projectId, ensured.worktreeDir, prefix, user.id);
    }
    try {
      await prisma.gitRepository.update({
        where: { id: fresh.id },
        data: { lastVerifiedAt: new Date() },
      });
    } catch {
      // Observability only.
    }
    const status = await buildStatusDto(ensured.worktreeDir, fresh);
    return {
      pulled: merged.updated,
      oldSha,
      newSha,
      status,
      reconciled: { filesUpserted: reconciled.filesUpserted, filesDeleted: reconciled.filesDeleted },
    };
  });
}

export async function pushProject(
  projectId: string,
  user: SessionUser,
  branchInput?: string,
): Promise<PushResultDto> {
  return withProjectGitLock(projectId, "push", async () => {
    const link = await requireLink(projectId);
    if (!link.owner || !link.repo) {
      throw new GitError("GIT_REMOTE_UNAVAILABLE", "No remote configured for this repository.");
    }
    requireKnownImportRoot(link);
    const token = await getGitHubToken(user.id);
    if (!token) {
      throw new GitError(
        "GIT_GITHUB_REAUTH_REQUIRED",
        "GitHub authentication is required for remote operations. Reconnect GitHub and retry.",
      );
    }
    // Fresh permission check: the stored snapshot is cache, not authority.
    const detail = await fetchRepoDetail(token, link.owner, link.repo);
    if (detail.error || !detail.repo) {
      const status = detail.error?.status ?? 0;
      if (status === 404) {
        throw new GitError("GIT_REMOTE_UNAVAILABLE", "GitHub repository is unavailable.");
      }
      if (status === 401 || status === 403) {
        throw new GitError(
          "GIT_GITHUB_REAUTH_REQUIRED",
          "GitHub authentication is required for remote operations. Reconnect GitHub and retry.",
        );
      }
      if (detail.error?.rateLimited) {
        throw new GitError("GIT_REMOTE_UNAVAILABLE", "GitHub rate limit reached. Try again shortly.");
      }
      throw new GitError("GIT_REMOTE_UNAVAILABLE", "Could not reach GitHub. Try again shortly.");
    }
    try {
      await prisma.gitRepository.update({
        where: { id: link.id },
        data: {
          canRead: detail.repo.access.canRead,
          canWrite: detail.repo.access.canWrite,
          canAdmin: detail.repo.access.canAdmin,
        },
      });
    } catch {
      // Snapshot metadata must never break the push.
    }
    if (!detail.repo.access.canWrite) {
      throw new GitError(
        "GIT_PUSH_DENIED",
        "GitHub denied push permission for this account. Push requires write access to the repository.",
      );
    }
    const ensured = await ensureRepository(projectId, user);
    const fresh = await requireLink(projectId);
    await ensureGitHubClone(projectId, user, fresh, ensured.worktreeDir);
    await verifyRemoteOrThrow(projectId, user);
    const requested = branchInput && branchInput.length > 0 ? branchInput : await currentBranch(ensured.worktreeDir);
    if (!isValidBranchName(requested)) {
      throw new GitError("GIT_INVALID_BRANCH", `Invalid branch name: ${requested}`);
    }
    const branches = await listBranches(ensured.worktreeDir);
    if (!branches.some((b) => !b.remote && b.name === requested)) {
      throw new GitError("GIT_BRANCH_NOT_FOUND", `Branch "${requested}" does not exist locally`);
    }
    const oldRemoteSha = await tryRevparse(ensured.worktreeDir, `origin/${requested}`);
    const upstream = await getUpstream(ensured.worktreeDir, requested).catch(() => null);
    // Explicit refspec, fixed origin, never any force flag (asserted by tests).
    await pushBranch(ensured.worktreeDir, requested, upstream === null, gitAuthEnv(token));
    const newSha = await tryRevparse(ensured.worktreeDir, requested);
    let ahead = 0;
    let behind = 0;
    try {
      const nextUpstream =
        (await getUpstream(ensured.worktreeDir, requested).catch(() => null)) ?? `origin/${requested}`;
      const ab = await aheadBehind(ensured.worktreeDir, requested, nextUpstream);
      ahead = ab.ahead;
      behind = ab.behind;
    } catch {
      ahead = 0;
      behind = 0;
    }
    try {
      await prisma.gitRepository.update({
        where: { id: fresh.id },
        data: { lastVerifiedAt: new Date() },
      });
    } catch {
      // Observability only.
    }
    return {
      branch: requested,
      remote: "origin",
      pushed: true,
      oldSha: oldRemoteSha,
      newSha,
      ahead,
      behind,
    };
  });
}

export async function getProjectHistory(
  projectId: string,
  user: SessionUser,
  input: { branch?: string; limit?: number; cursor?: string | null },
): Promise<HistoryDto> {
  const ensured = await ensureRepository(projectId, user);
  const current = await currentBranch(ensured.worktreeDir).catch(() => "HEAD");
  const rev = input.branch && input.branch.length > 0 ? input.branch : current;
  if (rev !== "HEAD" && !isValidBranchName(rev)) {
    throw new GitError("GIT_INVALID_BRANCH", `Invalid branch name: ${rev}`);
  }
  if (rev !== "HEAD") {
    const branches = await listBranches(ensured.worktreeDir);
    const known =
      branches.some((b) => !b.remote && b.name === rev) ||
      branches.some((b) => b.remote && b.remoteName === `origin/${rev}`);
    if (!known) {
      throw new GitError("GIT_BRANCH_NOT_FOUND", `Branch "${rev}" does not exist`);
    }
  }
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);
  const cursor = input.cursor ?? null;
  if (cursor !== null && !isCommitSha(cursor)) {
    throw new GitError("GIT_COMMIT_NOT_FOUND", "Commit does not exist");
  }
  const commits = await logCommits(ensured.worktreeDir, rev, limit, cursor);
  return {
    branch: rev,
    commits: commits.map((c) => ({
      sha: c.sha,
      shortSha: c.shortSha,
      message: c.message,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      timestamp: c.timestamp,
      parents: c.parents,
    })),
    hasMore: commits.length === limit,
  };
}

export async function getCommitDetail(
  projectId: string,
  user: SessionUser,
  sha: string,
): Promise<CommitDetailDto> {
  if (!isCommitSha(sha)) {
    throw new GitError("GIT_COMMIT_NOT_FOUND", "Commit does not exist");
  }
  const ensured = await ensureRepository(projectId, user);
  const link = await requireLink(projectId);
  const prefix = await readPrefix(ensured.worktreeDir, link.importRoot);
  const [meta, changes] = await Promise.all([
    commitMeta(ensured.worktreeDir, sha),
    commitFileChanges(ensured.worktreeDir, sha),
  ]);
  const files: CommitDetailDto["files"] = [];
  for (const f of changes.files) {
    const ide = toIdePath(prefix, f.path);
    if (ide === null) continue; // Outside the import scope.
    const oldIde = f.oldPath ? toIdePath(prefix, f.oldPath) : null;
    files.push({
      path: ide,
      ...(oldIde ? { oldPath: oldIde } : {}),
      status: f.status,
      ...(f.additions === undefined ? {} : { additions: f.additions }),
      ...(f.deletions === undefined ? {} : { deletions: f.deletions }),
      binary: f.binary,
    });
  }
  return {
    sha: meta.sha,
    shortSha: meta.shortSha,
    message: meta.message,
    authorName: meta.authorName,
    authorEmail: meta.authorEmail,
    timestamp: meta.timestamp,
    parents: meta.parents,
    files,
  };
}

export async function getHistoryDiff(
  projectId: string,
  user: SessionUser,
  sha: string,
  repoPath: string,
): Promise<HistoryDiffDto> {
  if (!isCommitSha(sha)) {
    throw new GitError("GIT_COMMIT_NOT_FOUND", "Commit does not exist");
  }
  const ensured = await ensureRepository(projectId, user);
  const link = await requireLink(projectId);
  const prefix = await readPrefix(ensured.worktreeDir, link.importRoot);
  const normalized = normalizeGitPath(repoPath);
  const gitPath = prefix === "" ? normalized : `${prefix}/${normalized}`;
  const diff = await historyFileDiff(ensured.worktreeDir, sha, gitPath);
  const ide = toIdePath(prefix, diff.path) ?? normalized;
  const oldIde = diff.oldPath ? (toIdePath(prefix, diff.oldPath) ?? undefined) : undefined;
  return {
    path: ide,
    ...(oldIde ? { oldPath: oldIde } : {}),
    status: diff.status,
    staged: false,
    isBinary: diff.isBinary,
    tooLarge: diff.tooLarge,
    oldContent: diff.oldContent,
    newContent: diff.newContent,
    sha: diff.sha,
  };
}
