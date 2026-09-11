import { prisma } from "@repo/db";
import { hasRepoScope } from "../github/github.service";
import { GitError } from "./git.errors";
import { isCommitSha, normalizeBranchName, normalizeGitPath, normalizeGitPathList } from "./git.paths";
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
import { materializeProjectToDir, readWorktreeFiles } from "./git.sync";
import { fileRepository } from "../projects/files/file.repository";
import { emitFileContentChanged, emitFileTreeChanged } from "../projects/files/file.events";
import { getActiveEditorService } from "../collab/collab.editor";

/**
 * Phase 4A — Git orchestration.
 *
 * Data flow: Postgres File rows (truth) <-> persistent worktree (git) ->
 * normalized DTOs. Every mutating op runs under the per-project lock.
 * Tokens never appear here: no remote operations exist in 4A.
 */

export const MAX_STATUS_ENTRIES = 2000;

export interface GitStatusEntry {
  path: string;
  oldPath?: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted";
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatusDto {
  branch: string;
  clean: boolean;
  truncated: boolean;
  totalCount: number;
  entries: GitStatusEntry[];
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

function toStatusDto(engine: EngineStatus): GitStatusDto {
  const totalCount = engine.entries.length;
  const truncated = totalCount > MAX_STATUS_ENTRIES;
  const entries: GitStatusEntry[] = (truncated ? engine.entries.slice(0, MAX_STATUS_ENTRIES) : engine.entries).map(
    (e) => ({
      path: e.path,
      ...(e.oldPath ? { oldPath: e.oldPath } : {}),
      status: e.status,
      staged: e.staged,
      unstaged: e.unstaged,
    }),
  );
  return {
    branch: engine.branch,
    // Never report clean when entries were cut.
    clean: !truncated && engine.clean,
    truncated,
    totalCount,
    entries,
  };
}

function toDiffDto(diff: EngineDiff): GitDiffDto {
  return {
    path: diff.path,
    ...(diff.oldPath ? { oldPath: diff.oldPath } : {}),
    status: diff.status,
    staged: diff.staged,
    isBinary: diff.isBinary,
    tooLarge: diff.tooLarge,
    oldContent: diff.oldContent,
    newContent: diff.newContent,
  };
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

async function bootstrapRepository(
  projectId: string,
  user: SessionUser,
  link: {
    id: string;
    owner: string | null;
    repo: string | null;
    fullName: string | null;
    defaultBranch: string;
    currentBranch: string;
    importedSha: string | null;
    initializedAt: Date | null;
  },
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
  const short = importedSha ? importedSha.slice(0, 7) : null;
  // Local-only repos get a plain initial commit; imports reference the
  // GitHub revision they snapshot (without claiming to BE that commit).
  const initialMessage =
    link.fullName && short ? `Import ${link.fullName}@${short}` : "Initial commit";
  const remoteUrl = link.owner && link.repo ? `https://github.com/${link.owner}/${link.repo}.git` : null;
  try {
    await ensureStorageRoot();
    await removeWorktreeDir(dir);
    await initRepo(dir, branch, remoteUrl, identity);
    // Preferred strategy: materialize the imported File rows (already
    // scoped to the Phase 3 root) and commit the exact snapshot.
    await materializeProjectToDir(projectId, dir);
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
  const status = await getStatus(ensured.worktreeDir);
  return toStatusDto(status);
}

export async function getProjectDiff(
  projectId: string,
  user: SessionUser,
  repoPath: string,
  staged: boolean,
): Promise<GitDiffDto> {
  const ensured = await ensureRepository(projectId, user);
  const normalized = normalizeGitPath(repoPath);
  return toDiffDto(await diffFile(ensured.worktreeDir, normalized, staged));
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
    const before = await getStatus(ensured.worktreeDir);
    const known = new Set(before.entries.map((e) => e.path));
    for (const p of normalized) {
      if (!known.has(p)) {
        throw new GitError("GIT_INVALID_PATH", `File has no Git changes: ${p}`);
      }
    }
    await stagePaths(ensured.worktreeDir, normalized);
    return toStatusDto(await getStatus(ensured.worktreeDir));
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
    const before = await getStatus(ensured.worktreeDir);
    const known = new Set(before.entries.map((e) => e.path));
    for (const p of normalized) {
      if (!known.has(p)) {
        throw new GitError("GIT_INVALID_PATH", `File has no Git changes: ${p}`);
      }
    }
    await unstagePaths(ensured.worktreeDir, normalized);
    return toStatusDto(await getStatus(ensured.worktreeDir));
  });
}

export async function stageAllPaths(projectId: string, user: SessionUser): Promise<GitStatusDto> {
  return withProjectGitLock(projectId, "stage-all", async () => {
    const ensured = await ensureRepository(projectId, user);
    await stageAll(ensured.worktreeDir);
    return toStatusDto(await getStatus(ensured.worktreeDir));
  });
}

export async function unstageAllPaths(projectId: string, user: SessionUser): Promise<GitStatusDto> {
  return withProjectGitLock(projectId, "unstage-all", async () => {
    const ensured = await ensureRepository(projectId, user);
    await unstageAll(ensured.worktreeDir);
    return toStatusDto(await getStatus(ensured.worktreeDir));
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
    const before = await getStatus(ensured.worktreeDir);
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
    const results = await discardPaths(ensured.worktreeDir, normalized);

    // Reconcile worktree -> File rows (preserve ids where possible).
    const restored: string[] = [];
    const removed: string[] = [];
    const changedFileIds: string[] = [];
    for (const r of results) {
      if (r.outcome === "restored") {
        const reads = await readWorktreeFiles(ensured.worktreeDir, [r.path]);
        const read = reads[0];
        if (read && !read.missing && read.content !== null) {
          const existing = await fileRepository.getFileByPath(projectId, r.path).catch(() => null);
          if (existing) {
            await fileRepository.updateFile(existing.id, projectId, {
              content: read.content,
              updatedByUserId: user.id,
            });
            changedFileIds.push(existing.id);
          } else {
            const parent = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : null;
            const parentId = parent ? await ensureFolderRow(projectId, parent, user.id) : null;
            const created = await fileRepository.createFile({
              projectId,
              name: r.path.split("/").pop() ?? r.path,
              content: read.content,
              parentId,
              isFolder: false,
              path: r.path,
              updatedByUserId: user.id,
            });
            changedFileIds.push(created.id);
          }
          restored.push(r.path);
        } else {
          // Restored entry vanished (e.g. directory edge) — drop the row.
          const existing = await fileRepository.getFileByPath(projectId, r.path).catch(() => null);
          if (existing && !existing.isFolder) {
            await fileRepository.deleteFile(existing.id, projectId);
            removed.push(r.path);
          }
        }
      } else if (r.outcome === "removed") {
        const existing = await fileRepository.getFileByPath(projectId, r.path).catch(() => null);
        if (existing) {
          await fileRepository.deleteFile(existing.id, projectId);
          removed.push(r.path);
        }
      }
    }
    emitFileTreeChanged(projectId);
    if (changedFileIds.length > 0) {
      emitFileContentChanged(projectId, changedFileIds);
    }
    const status = toStatusDto(await getStatus(ensured.worktreeDir));
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
    const before = await getStatus(ensured.worktreeDir);
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
      status: toStatusDto(await getStatus(ensured.worktreeDir)),
    };
  });
}
