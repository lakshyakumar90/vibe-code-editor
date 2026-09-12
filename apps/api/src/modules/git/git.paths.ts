import * as path from "node:path";
import { GitError } from "./git.errors";

/**
 * Phase 4A — repository-relative path authorization.
 *
 * Every path from the frontend is normalized and jailed inside the
 * project worktree. Rejects absolute paths, traversal, drive letters,
 * UNC shares, backslashes, and NUL bytes. Never concatenate unvalidated
 * paths into Git or filesystem calls — resolve through `resolveWorktreePath`.
 */

const MAX_GIT_PATH_LENGTH = 1024;

export function normalizeGitPath(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new GitError("GIT_INVALID_PATH", "Path must be a string");
  }
  if (raw.length === 0 || raw.length > MAX_GIT_PATH_LENGTH) {
    throw new GitError("GIT_INVALID_PATH", "Path has invalid length");
  }
  if (raw.includes("\0")) {
    throw new GitError("GIT_INVALID_PATH", "Path contains invalid characters");
  }
  // Reject Windows absolute forms before normalization can hide them.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    throw new GitError("GIT_INVALID_PATH", "Absolute paths are not allowed");
  }
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new GitError("GIT_INVALID_PATH", "Absolute paths are not allowed");
  }
  if (raw.includes("\\")) {
    throw new GitError("GIT_INVALID_PATH", "Backslashes are not allowed in repository paths");
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /(^|\/)\.\.(\/|$)/.test(normalized)
  ) {
    throw new GitError("GIT_INVALID_PATH", "Path escapes the repository");
  }
  // Flag injection: a leading dash could be parsed as a git option.
  // (Engine calls already separate options with `--`, but defense in depth.)
  if (/(^|\/)-/.test(normalized)) {
    throw new GitError("GIT_INVALID_PATH", "Path must not start a segment with a dash");
  }
  return normalized;
}

/** Dedupe + normalize a path list; empty lists are rejected by callers. */
export function normalizeGitPathList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new GitError("GIT_INVALID_PATH", "Paths must be an array");
  }
  const out = new Map<string, true>();
  for (const p of raw) {
    out.set(normalizeGitPath(p), true);
  }
  return [...out.keys()];
}

/**
 * Resolve a validated repo-relative path inside the worktree root.
 * Double-jails: the resolved absolute path must stay under root.
 */
export function resolveWorktreePath(worktreeRoot: string, repoPath: string): string {
  const normalized = normalizeGitPath(repoPath);
  const resolved = path.resolve(worktreeRoot, normalized);
  const root = path.resolve(worktreeRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new GitError("GIT_INVALID_PATH", "Path escapes the repository");
  }
  return resolved;
}

/** Maximum branch name length (well under git's ref limits). */
export const MAX_BRANCH_LENGTH = 128;

/**
 * Phase 4B — centralized branch-name validation (pure).
 * Mirrors `git check-ref-format` rules conservatively: no traversal,
 * no flag-like leading dashes, no refspec metacharacters, no `@{`
 * reflog syntax, no `.lock` suffixes. The engine additionally confirms
 * with `git check-ref-format --branch` before use.
 */
export function isValidBranchName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_BRANCH_LENGTH) return false;
  if (value === "HEAD") return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(value)) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("@")) return false;
  if (value.includes("//")) return false;
  if (value === "refs" || value.startsWith("refs/")) return false;
  const segs = value.split("/");
  for (const s of segs) {
    if (s.length === 0 || s === "." || s === "..") return false;
    if (s.startsWith(".") || s.startsWith("-")) return false;
    if (s.endsWith(".") || s.endsWith(".lock")) return false;
  }
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return false;
  return true;
}

/** Validate a branch name for `git init -b` (no shell involved, still strict). */
export function normalizeBranchName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
    throw new GitError("GIT_OPERATION_FAILED", "Invalid branch name");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(raw) || raw.includes("..")) {
    throw new GitError("GIT_OPERATION_FAILED", "Invalid branch name");
  }
  return raw;
}

/** True for 40–64 char hex commit SHAs (never confuse with branch names). */
export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);
}
