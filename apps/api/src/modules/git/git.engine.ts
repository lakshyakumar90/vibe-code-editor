import * as fs from "node:fs";
import * as path from "node:path";
import { simpleGit, type SimpleGit, type StatusResult } from "simple-git";
import { GitError } from "./git.errors";
import { normalizeBranchName, resolveWorktreePath } from "./git.paths";
import { hasGitDir } from "./git.store";

/**
 * Phase 4A — server-side Git engine (simple-git wrapper).
 *
 * The ONLY module that touches the `git` binary. All operations are local
 * (status/diff/show/add/reset/checkout/commit/rev-parse/init/config/remote
 * add) — no fetch/pull/push/clone. No method accepts user-supplied args;
 * every path is validated + jailed before use.
 */

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export interface EngineStatusEntry {
  /** Repo-relative posix path (new path for renames). */
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface EngineStatus {
  branch: string;
  clean: boolean;
  entries: EngineStatusEntry[];
}

export interface CommitIdentity {
  name: string;
  email: string;
}

const MAX_DIFF_BYTES = 256 * 1024;

function git(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd, trimmed: false });
}

/** Map porcelain XY codes to a normalized status. */
function classify(index: string, working: string): GitFileStatus {
  if (index === "U" || working === "U") return "conflicted";
  if (index === "?" && working === "?") return "untracked";
  if (index === "R" || working === "R") return "renamed";
  if (index === "C" || working === "C") return "copied";
  if (index === "A" || (index === " " && working === "A")) return "added";
  if (index === "D" || working === "D") return "deleted";
  return "modified";
}

function wrapError(operation: string, err: unknown): GitError {
  const raw = err instanceof Error ? err.message : String(err);
  // Server log keeps the detail; the client gets a stable code + summary.
  console.error(`[git:${operation}]`, raw.slice(0, 500));
  if (err instanceof GitError) return err;
  return new GitError("GIT_OPERATION_FAILED", `Git ${operation} failed`);
}

export async function verifyRepoDir(worktreeDir: string): Promise<void> {
  if (!(await hasGitDir(worktreeDir))) {
    throw new GitError("GIT_REPOSITORY_NOT_READY", "Git repository is not initialized for this project");
  }
}

export async function initRepo(
  worktreeDir: string,
  branch: string,
  remoteUrl: string | null,
  identity: CommitIdentity,
): Promise<void> {
  const validatedBranch = normalizeBranchName(branch);
  try {
    await fs.promises.mkdir(worktreeDir, { recursive: true });
    const g = git(worktreeDir);
    await g.init(["-b", validatedBranch]);
    await g.addConfig("user.name", identity.name);
    await g.addConfig("user.email", identity.email);
    // Credential-free remote (https URL only) for future phases. No network use.
    if (remoteUrl) {
      await g.addRemote("origin", remoteUrl);
    }
  } catch (err) {
    throw wrapError("init", err);
  }
}

export async function ensureIdentity(worktreeDir: string, identity: CommitIdentity): Promise<void> {
  try {
    const g = git(worktreeDir);
    await g.addConfig("user.name", identity.name);
    await g.addConfig("user.email", identity.email);
  } catch (err) {
    throw wrapError("config", err);
  }
}

export async function revparseHead(worktreeDir: string): Promise<string | null> {
  try {
    const sha = (await git(worktreeDir).revparse(["HEAD"])).trim();
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
  } catch {
    return null; // Unborn HEAD (no commits yet) or broken repo.
  }
}

export async function currentBranch(worktreeDir: string): Promise<string> {
  try {
    const status = await git(worktreeDir).status();
    return status.current ?? "HEAD";
  } catch (err) {
    throw wrapError("branch", err);
  }
}

export async function getStatus(worktreeDir: string): Promise<EngineStatus> {
  await verifyRepoDir(worktreeDir);
  let result: StatusResult;
  try {
    result = await git(worktreeDir).status();
  } catch (err) {
    throw wrapError("status", err);
  }
  const entries: EngineStatusEntry[] = [];
  for (const f of result.files ?? []) {
    const index = f.index as string;
    const working = f.working_dir as string;
    const status = classify(index, working);
    entries.push({
      path: f.path,
      ...(typeof f.from === "string" && f.from.length > 0 ? { oldPath: f.from } : {}),
      status,
      staged: index !== " " && index !== "?",
      unstaged: working !== " " && (status === "untracked" || working !== " "),
    });
  }
  // simple-git also reports renames separately in some versions — merge any
  // that didn't arrive with a `from` on the file entry.
  const seen = new Set(entries.map((e) => e.path));
  const renamed = (result as unknown as { renamed?: Array<{ from: string; to: string }> }).renamed;
  if (Array.isArray(renamed)) {
    for (const r of renamed) {
      if (typeof r?.to === "string" && !seen.has(r.to)) {
        entries.push({
          path: r.to,
          ...(typeof r.from === "string" ? { oldPath: r.from } : {}),
          status: "renamed",
          staged: true,
          unstaged: false,
        });
        seen.add(r.to);
      }
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    branch: result.current ?? "HEAD",
    clean: result.isClean(),
    entries,
  };
}

export interface EngineDiff {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  staged: boolean;
  isBinary: boolean;
  tooLarge: boolean;
  oldContent: string | null;
  newContent: string | null;
}

async function showRevision(worktreeDir: string, revPath: string): Promise<string | null> {
  try {
    const out = await git(worktreeDir).raw(["show", revPath]);
    return typeof out === "string" ? out : null;
  } catch {
    return null; // Path absent at that revision (added/deleted).
  }
}

async function isBinaryPath(worktreeDir: string, args: string[]): Promise<boolean> {
  try {
    const out = await git(worktreeDir).raw(args);
    const first = typeof out === "string" ? out.split("\n")[0] ?? "" : "";
    return first.startsWith("-\t-");
  } catch {
    return false;
  }
}

function looksBinaryText(s: string): boolean {
  return s.includes("\0");
}

export async function diffFile(
  worktreeDir: string,
  repoPath: string,
  staged: boolean,
): Promise<EngineDiff> {
  await verifyRepoDir(worktreeDir);
  resolveWorktreePath(worktreeDir, repoPath);
  // Determine the entry's status first (drives old/new resolution).
  const status = await getStatus(worktreeDir);
  const entry = status.entries.find((e) => e.path === repoPath);
  if (!entry) {
    throw new GitError("GIT_INVALID_PATH", "File has no Git changes");
  }
  try {
    const binaryArgs = staged
      ? ["diff", "--numstat", "--cached", "--", repoPath]
      : ["diff", "--numstat", "HEAD", "--", repoPath];
    const binary = await isBinaryPath(worktreeDir, binaryArgs);
    if (binary) {
      return {
        path: repoPath,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
        status: entry.status,
        staged,
        isBinary: true,
        tooLarge: false,
        oldContent: null,
        newContent: null,
      };
    }
    const headRef = entry.oldPath ?? repoPath;
    const oldContent = await showRevision(worktreeDir, `HEAD:${headRef}`);
    let newContent: string | null;
    if (staged) {
      newContent = await showRevision(worktreeDir, `:${repoPath}`);
    } else {
      const abs = resolveWorktreePath(worktreeDir, repoPath);
      try {
        const st = await fs.promises.stat(abs);
        if (!st.isFile()) {
          newContent = null;
        } else if (st.size > MAX_DIFF_BYTES) {
          return {
            path: repoPath,
            ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
            status: entry.status,
            staged,
            isBinary: false,
            tooLarge: true,
            oldContent: null,
            newContent: null,
          };
        } else {
          newContent = await fs.promises.readFile(abs, "utf8");
        }
      } catch {
        newContent = null; // Deleted from worktree.
      }
    }
    if (
      (oldContent !== null && oldContent.length > MAX_DIFF_BYTES) ||
      (newContent !== null && newContent.length > MAX_DIFF_BYTES)
    ) {
      return {
        path: repoPath,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
        status: entry.status,
        staged,
        isBinary: false,
        tooLarge: true,
        oldContent: null,
        newContent: null,
      };
    }
    if (
      (oldContent !== null && looksBinaryText(oldContent)) ||
      (newContent !== null && looksBinaryText(newContent))
    ) {
      return {
        path: repoPath,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
        status: entry.status,
        staged,
        isBinary: true,
        tooLarge: false,
        oldContent: null,
        newContent: null,
      };
    }
    return {
      path: repoPath,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      staged,
      isBinary: false,
      tooLarge: false,
      oldContent,
      newContent,
    };
  } catch (err) {
    throw wrapError("diff", err);
  }
}

export async function stagePaths(worktreeDir: string, paths: string[]): Promise<void> {
  await verifyRepoDir(worktreeDir);
  const validated = paths.map((p) => resolveWorktreePath(worktreeDir, p));
  // Re-derive repo-relative names from jailed absolutes (defense in depth).
  const rel = validated.map((abs) => path.relative(worktreeDir, abs).split(path.sep).join("/"));
  try {
    await git(worktreeDir).add(rel);
  } catch (err) {
    throw wrapError("stage", err);
  }
}

export async function stageAll(worktreeDir: string): Promise<void> {
  await verifyRepoDir(worktreeDir);
  try {
    await git(worktreeDir).add(["-A"]);
  } catch (err) {
    throw wrapError("stage", err);
  }
}

export async function unstagePaths(worktreeDir: string, paths: string[]): Promise<void> {
  await verifyRepoDir(worktreeDir);
  const validated = paths.map((p) => resolveWorktreePath(worktreeDir, p));
  const rel = validated.map((abs) => path.relative(worktreeDir, abs).split(path.sep).join("/"));
  try {
    await git(worktreeDir).reset(["HEAD", "--", ...rel]);
  } catch (err) {
    throw wrapError("unstage", err);
  }
}

export async function unstageAll(worktreeDir: string): Promise<void> {
  await verifyRepoDir(worktreeDir);
  try {
    await git(worktreeDir).reset([]);
  } catch (err) {
    throw wrapError("unstage", err);
  }
}

export interface DiscardResult {
  path: string;
  outcome: "restored" | "removed" | "unchanged";
}

/**
 * Discard tracked modifications per path. Untracked files are rejected by
 * the caller (never implicitly deleted). Staged-new files are unstaged and
 * removed from the worktree; everything else restores from HEAD.
 */
export async function discardPaths(worktreeDir: string, paths: string[]): Promise<DiscardResult[]> {
  await verifyRepoDir(worktreeDir);
  const g = git(worktreeDir);
  const results: DiscardResult[] = [];
  for (const repoPath of paths) {
    const abs = resolveWorktreePath(worktreeDir, repoPath);
    try {
      await g.reset(["HEAD", "--", repoPath]);
      try {
        await g.checkout(["HEAD", "--", repoPath]);
        results.push({ path: repoPath, outcome: "restored" });
      } catch {
        // Not in HEAD (staged-new): drop the worktree file instead.
        await fs.promises.rm(abs, { recursive: true, force: true });
        results.push({ path: repoPath, outcome: "removed" });
      }
    } catch (err) {
      throw wrapError(`discard ${repoPath}`, err);
    }
  }
  return results;
}

export interface CommitResult {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
}

/**
 * Empty initialization commit (bootstrap of projects with zero files).
 * Identity comes from repo-local config (set via ensureIdentity first).
 */
export async function commitAllowEmpty(worktreeDir: string, message: string): Promise<CommitResult> {
  await verifyRepoDir(worktreeDir);
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) {
    throw new GitError("GIT_COMMIT_INVALID_MESSAGE", "Commit message must be 1-2000 characters");
  }
  try {
    const summary = await git(worktreeDir).commit(trimmed, { "--allow-empty": null });
    const sha = (summary.commit || "").trim();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      throw new GitError("GIT_OPERATION_FAILED", "Commit did not produce a valid SHA");
    }
    const author = await git(worktreeDir).raw(["show", "-s", "--format=%an%x00%ae", "HEAD"]);
    const [authorName = "", authorEmail = ""] = (typeof author === "string" ? author : "").split("\0");
    return {
      sha,
      message: trimmed,
      authorName: authorName.trim(),
      authorEmail: authorEmail.trim(),
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof GitError) throw err;
    throw wrapError("commit", err);
  }
}

export async function commitStaged(
  worktreeDir: string,
  message: string,
  identity: CommitIdentity,
): Promise<CommitResult> {
  await verifyRepoDir(worktreeDir);
  const trimmed = message.trim().replace(/\s+$/g, "");
  if (trimmed.length === 0) {
    throw new GitError("GIT_COMMIT_INVALID_MESSAGE", "Commit message must not be empty");
  }
  if (trimmed.length > 2000) {
    throw new GitError("GIT_COMMIT_INVALID_MESSAGE", "Commit message must be at most 2000 characters");
  }
  try {
    const g = git(worktreeDir);
    await g.addConfig("user.name", identity.name);
    await g.addConfig("user.email", identity.email);
    const summary = await g.commit(trimmed, undefined, {
      "--author": `${identity.name} <${identity.email}>`,
    });
    const sha = (summary.commit || "").trim();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      throw new GitError("GIT_OPERATION_FAILED", "Commit did not produce a valid SHA");
    }
    return {
      sha,
      message: trimmed,
      authorName: identity.name,
      authorEmail: identity.email,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof GitError) throw err;
    const raw = err instanceof Error ? err.message : String(err);
    if (/nothing to commit|empty/i.test(raw)) {
      throw new GitError("GIT_NO_CHANGES", "There are no staged changes to commit");
    }
    throw wrapError("commit", err);
  }
}
