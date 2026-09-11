import * as fs from "node:fs";
import * as path from "node:path";
import { GitError } from "./git.errors";

/**
 * Phase 4A — persistent worktree storage.
 *
 * Each GitRepository gets a deterministic server-side directory derived
 * ONLY from its database id:
 *
 *   <GIT_STORAGE_ROOT>/<gitRepositoryId>/
 *
 * Never from user input (owner/repo/request params) — path traversal is
 * structurally impossible. The directory lives outside /tmp, outside
 * WebContainer, outside the browser; it survives refresh, remount,
 * reconnects, and API request boundaries.
 */

function storageRoot(): string {
  const configured = process.env["GIT_STORAGE_ROOT"];
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }
  return path.resolve(process.cwd(), ".git-worktrees");
}

/** Validate a GitRepository id before it touches the filesystem. */
function assertRepositoryId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new GitError("GIT_OPERATION_FAILED", "Invalid repository reference");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new GitError("GIT_OPERATION_FAILED", "Invalid repository reference");
  }
  return id;
}

/** Absolute worktree dir for a GitRepository id. Creates nothing. */
export function worktreeDirFor(gitRepositoryId: string): string {
  const id = assertRepositoryId(gitRepositoryId);
  const root = storageRoot();
  return path.join(root, id);
}

/** Ensure the storage root exists (idempotent). */
export async function ensureStorageRoot(): Promise<string> {
  const root = storageRoot();
  await fs.promises.mkdir(root, { recursive: true });
  return root;
}

/** True when dir looks like a git worktree (has a .git directory). */
export async function hasGitDir(worktreeDir: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(path.join(worktreeDir, ".git"));
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Remove an entire worktree directory (bootstrap rebuild only). */
export async function removeWorktreeDir(worktreeDir: string): Promise<void> {
  const root = storageRoot();
  const resolved = path.resolve(worktreeDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new GitError("GIT_INVALID_PATH", "Refusing to remove outside the Git storage root");
  }
  await fs.promises.rm(resolved, { recursive: true, force: true });
}
