import * as fs from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";
import { GitError } from "./git.errors";
import { isCommitSha, isValidBranchName, normalizeGitPath } from "./git.paths";
import { MAX_DIFF_BYTES } from "./git.engine";
import type { GitFileStatus } from "./git.engine";

/**
 * Phase 4B — remote/branch/history Git transport (simple-git wrapper).
 *
 * Same rules as `git.engine.ts`: typed methods only, validated inputs,
 * fixed `origin` remote, argv calls (no shell). Remote authentication uses
 * per-process `GIT_CONFIG_*` environment entries (`http.extraHeader`) —
 * credentials are NEVER written to `.git/config`, never logged, never
 * returned. Remote ops are wrapped in a timeout (simple-git has none).
 */

export const REMOTE_TIMEOUT_MS = 60_000;
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const CLONE_MARKER_KEY = "vibe.bootstrap";
export const CLONE_MARKER_VALUE = "clone";

/**
 * Minimal child environment for git. simple-git passes ONLY its custom env
 * object to the child (no process.env merge), but merging all of
 * process.env trips simple-git's env protections (EDITOR and friends) — so
 * we forward just what git needs to run plus our GIT_* entries.
 */
const FORWARDED_ENV_KEYS = [
  "SystemRoot",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TZ",
];

function rgit(cwd: string | undefined, extraEnv: Record<string, string>): SimpleGit {
  const merged: Record<string, string> = {};
  for (const k of FORWARDED_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === "string") merged[k] = v;
  }
  Object.assign(merged, extraEnv);
  const base = cwd ? simpleGit({ baseDir: cwd, trimmed: false }) : simpleGit({ trimmed: false });
  return base.env(merged);
}

/**
 * Credential material for ONE git process. The token travels only in the
 * child process environment (GIT_CONFIG_COUNT/KEY/VALUE composition, a
 * native git feature) plus a prompt kill-switch. Never persisted anywhere.
 */
export function gitAuthEnv(token: string | null): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (token) {
    env["GIT_CONFIG_COUNT"] = "1";
    env["GIT_CONFIG_KEY_0"] = "http.extraHeader";
    env["GIT_CONFIG_VALUE_0"] = `Authorization: Bearer ${token}`;
  }
  return env;
}

/** Strip any credential-shaped material from diagnostics. Pure. */
export function sanitizeRemoteMessage(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bgh[op]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\bgithu?b_pat_[A-Za-z0-9_]+/gi, "[redacted]")
    .replace(/https:\/\/[^@\s/]+@/g, "https://[redacted]@")
    .slice(0, 300);
}

type RemoteOp = "fetch" | "push" | "pull" | "clone";

/** Classify transport failures into stable codes (never leaks secrets). */
export function classifyTransportError(op: RemoteOp, err: unknown): GitError {
  const raw = err instanceof Error ? err.message : String(err);
  console.error(`[git:${op}]`, sanitizeRemoteMessage(raw));
  if (err instanceof GitError) return err;
  const m = raw;
  if (
    /authentication failed|invalid credentials|\b401\b|unauthorized|access denied|permission denied \(publickey|password\)|could not read username|terminal prompts disabled|empty password|logon failed|fatal: unable to access/i.test(
      m,
    )
  ) {
    return new GitError(
      "GIT_GITHUB_REAUTH_REQUIRED",
      "GitHub authentication failed. Reconnect GitHub and retry.",
    );
  }
  if (op === "push" && /permission to .* denied/i.test(m)) {
    return new GitError("GIT_PUSH_DENIED", "GitHub denied push permission for this account.");
  }
  if (op === "push" && /non-fast-forward|fetch first|\[rejected\]|protected branch|branch protection|GH006|policy.*reject/i.test(m)) {
    return new GitError(
      "GIT_PUSH_REJECTED",
      "GitHub rejected the push. Fetch/pull before pushing.",
    );
  }
  if (op === "pull" && /not possible to fast-forward|divergent branches|need to merge|diverge/i.test(m)) {
    return new GitError(
      "GIT_PULL_DIVERGED",
      "Local and remote branches have diverged. Automatic pull was not performed.",
    );
  }
  if (/could not resolve host|repository not found|not found|does not exist|no such repository|invalid repository/i.test(m)) {
    return new GitError("GIT_REMOTE_UNAVAILABLE", "GitHub repository is unavailable.");
  }
  if (
    /network is unreachable|connection timed out|connection refused|connection reset|timed out|operation timed out|unable to connect|recv failure|early EOF|the remote end hung up/i.test(
      m,
    )
  ) {
    return new GitError("GIT_REMOTE_UNAVAILABLE", "Could not reach GitHub. Try again shortly.");
  }
  return new GitError("GIT_OPERATION_FAILED", `Git ${op} failed`);
}

/**
 * Timeout wrapper (simple-git has no timeout support). NOTE: on timeout the
 * child git process may linger briefly; the per-project lock is released so
 * the UI stays usable, and git's own index.lock prevents corruption from
 * any overlap (a subsequent op fails safely, never corrupts).
 */
export async function withRemoteTimeout<T>(label: string, fn: () => Promise<T>, ms = REMOTE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new GitError("GIT_REMOTE_TIMEOUT", `Git ${label} timed out`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Only https/file/local-path remotes may ever be contacted. */
export function assertSafeRemoteUrl(url: unknown): string {
  if (typeof url !== "string" || url.length === 0 || url.length > 512) {
    throw new GitError("GIT_OPERATION_FAILED", "Invalid remote URL");
  }
  if (url.startsWith("file://")) {
    if (url.length > "file://".length) return url;
    throw new GitError("GIT_OPERATION_FAILED", "Invalid remote URL");
  }
  if (url.startsWith("https://")) {
    const rest = url.slice("https://".length);
    if (rest.length > 0 && !rest.startsWith("/")) return url;
    throw new GitError("GIT_OPERATION_FAILED", "Invalid remote URL");
  }
  // Absolute local paths (bare-repo test remotes). No scheme => no network.
  if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(url) && !url.includes("\0")) return url;
  throw new GitError("GIT_OPERATION_FAILED", "Unsupported remote URL scheme");
}

function assertBranch(value: string): void {
  if (!isValidBranchName(value)) {
    throw new GitError("GIT_INVALID_BRANCH", `Invalid branch name: ${value}`);
  }
}

/** Confirm with git itself (catches `.lock`, `@{`, empty, etc.). */
export async function validateBranchRef(worktreeDir: string, name: string): Promise<void> {
  assertBranch(name);
  try {
    await rgit(worktreeDir, {}).raw(["check-ref-format", "--branch", name]);
  } catch {
    throw new GitError("GIT_INVALID_BRANCH", `Invalid branch name: ${name}`);
  }
}

/** Full clone into a fresh dir (caller removes any previous worktree). */
export async function cloneRepo(
  url: string,
  dir: string,
  authEnv: Record<string, string>,
): Promise<void> {
  const safeUrl = assertSafeRemoteUrl(url);
  try {
    // simple-git requires an existing baseDir; the absolute target stands
    // on its own, so the process cwd is a safe anchor.
    await withRemoteTimeout("clone", () => rgit(process.cwd(), authEnv).clone(safeUrl, dir));
  } catch (err) {
    throw classifyTransportError("clone", err);
  }
}

/**
 * Restrict the worktree to exactly the import root (non-cone pattern).
 * Cone mode would keep all root-level files (wrong for monorepo scoping);
 * the exact `<root>/` pattern checks out only that subtree.
 */
export async function setSparseRoot(worktreeDir: string, importRoot: string): Promise<void> {
  if (!importRoot) return;
  // Reuse the path jail: a root with traversal/dashes never reaches git.
  const root = normalizeGitPath(importRoot);
  try {
    const g = rgit(worktreeDir, {});
    await g.raw(["sparse-checkout", "init", "--no-cone"]);
    await g.raw(["sparse-checkout", "set", `${root}/`]);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[git:sparse]", sanitizeRemoteMessage(raw).slice(0, 300));
    throw new GitError("GIT_BOOTSTRAP_FAILED", "Could not configure the repository checkout");
  }
}

export async function getCloneMarker(worktreeDir: string): Promise<string | null> {
  try {
    const out = await rgit(worktreeDir, {}).raw(["config", "--get", CLONE_MARKER_KEY]);
    const v = typeof out === "string" ? out.trim() : "";
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function setCloneMarker(worktreeDir: string): Promise<void> {
  try {
    await rgit(worktreeDir, {}).raw(["config", CLONE_MARKER_KEY, CLONE_MARKER_VALUE]);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[git:marker]", sanitizeRemoteMessage(raw).slice(0, 300));
    throw new GitError("GIT_BOOTSTRAP_FAILED", "Could not record repository provenance");
  }
}

export async function commitCount(worktreeDir: string): Promise<number | null> {
  try {
    const out = await rgit(worktreeDir, {}).raw(["rev-list", "--count", "HEAD"]);
    const n = Number.parseInt(String(out).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function tryRevparse(worktreeDir: string, ref: string): Promise<string | null> {
  try {
    const out = await rgit(worktreeDir, {}).raw(["rev-parse", "--verify", ref]);
    const sha = String(out).trim();
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function getRemoteUrl(worktreeDir: string): Promise<string | null> {
  try {
    const out = await rgit(worktreeDir, {}).raw(["config", "--get", "remote.origin.url"]);
    const url = String(out).trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export interface RemoteBranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  remoteName?: string;
  commit: string;
}

/** Local + remote-tracking branches (no network). `remotes/` prefix stripped. */
export async function listBranches(worktreeDir: string): Promise<RemoteBranchInfo[]> {
  let summary: { all: string[]; branches: Record<string, { current: boolean; name: string; commit: string; label: string }>; current: string };
  try {
    summary = (await rgit(worktreeDir, {}).branch(["-a"])) as unknown as typeof summary;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[git:branches]", sanitizeRemoteMessage(raw).slice(0, 300));
    throw new GitError("GIT_OPERATION_FAILED", "Could not list branches");
  }
  const out: RemoteBranchInfo[] = [];
  for (const full of summary.all ?? []) {
    if (full.startsWith("remotes/")) {
      // remotes/origin/main -> remote origin/main
      const without = full.slice("remotes/".length);
      const slash = without.indexOf("/");
      if (slash === -1) continue;
      const remoteName = without.slice(0, slash);
      const name = without.slice(slash + 1);
      if (name === "HEAD" || name.endsWith("/HEAD")) continue;
      out.push({
        name,
        current: false,
        remote: true,
        remoteName: `${remoteName}/${name}`,
        commit: summary.branches[full]?.commit ?? "",
      });
    } else {
      out.push({
        name: full,
        current: full === summary.current,
        remote: false,
        commit: summary.branches[full]?.commit ?? "",
      });
    }
  }
  out.sort((a, b) => `${a.remote ? 1 : 0}${a.name}`.localeCompare(`${b.remote ? 1 : 0}${b.name}`));
  return out;
}

/** Upstream of a local branch (`origin/main`), or null when unset. */
export async function getUpstream(worktreeDir: string, branch: string): Promise<string | null> {
  assertBranch(branch);
  try {
    const out = await rgit(worktreeDir, {}).raw([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      `${branch}@{upstream}`,
    ]);
    const v = String(out).trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

/** Ancestry-based ahead/behind via `git rev-list --left-right --count`. */
export async function aheadBehind(
  worktreeDir: string,
  localRef: string,
  upstreamRef: string,
): Promise<AheadBehind> {
  assertBranch(localRef);
  assertBranch(upstreamRef);
  try {
    const out = await rgit(worktreeDir, {}).raw([
      "rev-list",
      "--left-right",
      "--count",
      `${localRef}...${upstreamRef}`,
    ]);
    const parts = String(out).trim().split(/\s+/);
    const ahead = Number.parseInt(parts[0] ?? "0", 10);
    const behind = Number.parseInt(parts[1] ?? "0", 10);
    return {
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[git:ahead-behind]", sanitizeRemoteMessage(raw).slice(0, 300));
    throw new GitError("GIT_OPERATION_FAILED", "Could not compare branch ancestry");
  }
}

/** Authenticated fetch of `origin` (+ prune). Touches refs only. */
export async function fetchOrigin(
  worktreeDir: string,
  authEnv: Record<string, string>,
): Promise<void> {
  try {
    await withRemoteTimeout("fetch", () => rgit(worktreeDir, authEnv).fetch(["--prune", "origin"]));
  } catch (err) {
    throw classifyTransportError("fetch", err);
  }
}

export interface MergeResult {
  updated: boolean;
  newSha: string | null;
}

/** Fast-forward-only merge of an upstream ref. Never creates merge commits. */
export async function mergeFastForward(worktreeDir: string, upstreamRef: string): Promise<MergeResult> {
  assertBranch(upstreamRef);
  const before = await tryRevparse(worktreeDir, "HEAD");
  try {
    await withRemoteTimeout("pull", () => rgit(worktreeDir, {}).merge(["--ff-only", upstreamRef]));
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/not possible to fast-forward|divergent branches|need to merge|diverge/i.test(raw)) {
      throw new GitError(
        "GIT_PULL_DIVERGED",
        "Local and remote branches have diverged. Automatic pull was not performed.",
      );
    }
    if (/local changes.*overwritten|your local changes/i.test(raw)) {
      throw new GitError(
        "GIT_DIRTY_WORKTREE",
        "Local changes would be overwritten. Commit, discard, or stash them first.",
      );
    }
    throw classifyTransportError("pull", err);
  }
  const after = await tryRevparse(worktreeDir, "HEAD");
  return { updated: before !== after, newSha: after };
}

/** Push the branch to `origin`. Never force-pushes (no flag surface at all). */
export async function pushBranch(
  worktreeDir: string,
  branch: string,
  setUpstream: boolean,
  authEnv: Record<string, string>,
): Promise<void> {
  assertBranch(branch);
  try {
    const g = rgit(worktreeDir, authEnv);
    if (setUpstream) {
      await withRemoteTimeout("push", () => g.push("origin", branch, { "--set-upstream": null }));
    } else {
      await withRemoteTimeout("push", () => g.push("origin", branch));
    }
  } catch (err) {
    throw classifyTransportError("push", err);
  }
}

/** Create a branch WITHOUT checking it out. Never pushes. */
export async function createBranch(
  worktreeDir: string,
  name: string,
  startPoint: string,
): Promise<void> {
  assertBranch(name);
  if (startPoint !== "HEAD" && !isValidBranchName(startPoint) && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(startPoint)) {
    throw new GitError("GIT_INVALID_BRANCH", `Invalid branch start point: ${startPoint}`);
  }
  try {
    await rgit(worktreeDir, {}).branch([name, startPoint]);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(raw)) {
      throw new GitError("GIT_BRANCH_EXISTS", `Branch "${name}" already exists`);
    }
    console.error("[git:create-branch]", sanitizeRemoteMessage(raw).slice(0, 300));
    throw new GitError("GIT_OPERATION_FAILED", "Could not create branch");
  }
}

export async function checkoutBranch(worktreeDir: string, name: string): Promise<void> {
  assertBranch(name);
  try {
    await rgit(worktreeDir, {}).checkout(name);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/did not match any file|unknown revision|pathspec/i.test(raw)) {
      throw new GitError("GIT_BRANCH_NOT_FOUND", `Branch "${name}" does not exist locally`);
    }
    if (/local changes.*overwritten|your local changes|untracked working tree files/i.test(raw)) {
      throw new GitError(
        "GIT_DIRTY_WORKTREE",
        "Local changes would be overwritten by checkout. Commit or discard them first.",
      );
    }
    console.error("[git:checkout]", sanitizeRemoteMessage(raw).slice(0, 300));
    throw new GitError("GIT_OPERATION_FAILED", "Could not switch branches");
  }
}

/** Checkout a remote branch by creating a local tracking branch. */
export async function checkoutTracking(
  worktreeDir: string,
  localName: string,
  remoteShort: string,
): Promise<void> {
  assertBranch(localName);
  assertBranch(remoteShort);
  try {
    await rgit(worktreeDir, {}).checkout(["-b", localName, "--track", `origin/${remoteShort}`]);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(raw)) {
      throw new GitError("GIT_BRANCH_EXISTS", `Branch "${localName}" already exists`);
    }
    if (/unknown revision|not found|couldn't find remote ref/i.test(raw)) {
      throw new GitError("GIT_BRANCH_NOT_FOUND", `Remote branch "origin/${remoteShort}" does not exist`);
    }
    if (/local changes.*overwritten|your local changes|untracked working tree files/i.test(raw)) {
      throw new GitError(
        "GIT_DIRTY_WORKTREE",
        "Local changes would be overwritten by checkout. Commit or discard them first.",
      );
    }
    console.error("[git:checkout-tracking]", sanitizeRemoteMessage(raw).slice(0, 300));
    throw new GitError("GIT_OPERATION_FAILED", "Could not switch branches");
  }
}

export interface LogCommit {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  parents: string[];
}

const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s";

/**
 * Bounded history (newest first). Cursor = a commit from an earlier page;
 * the next page starts at its first parent (`cursor^`), which is stable
 * under concurrent pushes (unlike offsets). Root cursors yield no page.
 * The cursor is expected on the requested branch's history.
 */
export async function logCommits(
  worktreeDir: string,
  rev: string,
  limit: number,
  cursor: string | null,
): Promise<LogCommit[]> {
  let range = rev;
  if (cursor) {
    if (!isCommitSha(cursor)) {
      throw new GitError("GIT_COMMIT_NOT_FOUND", "Commit does not exist");
    }
    const parent = await tryRevparse(worktreeDir, `${cursor}^`);
    if (!parent) return [];
    range = parent;
  }
  let out: string;
  try {
    out = await rgit(worktreeDir, {}).raw(["log", `--format=${LOG_FORMAT}`, "-n", String(limit), range]);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[git:log]", sanitizeRemoteMessage(raw).slice(0, 300));
    throw new GitError("GIT_OPERATION_FAILED", "Could not read commit history");
  }
  const commits: LogCommit[] = [];
  for (const line of String(out).split("\n")) {
    if (!line.trim()) continue;
    const [sha = "", shortSha = "", authorName = "", authorEmail = "", at = "", parents = "", message = ""] =
      line.split("\x1f");
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) continue;
    commits.push({
      sha,
      shortSha: shortSha || sha.slice(0, 7),
      message,
      authorName,
      authorEmail,
      timestamp: new Date(Number.parseInt(at || "0", 10) * 1000).toISOString(),
      parents: parents.split(" ").map((p) => p.trim()).filter((p) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(p)),
    });
  }
  return commits;
}

export interface CommitMeta {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  parents: string[];
}

/** Metadata for one commit (subject line only; bodies stay out of scope). */
export async function commitMeta(worktreeDir: string, sha: string): Promise<CommitMeta> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
    throw new GitError("GIT_COMMIT_NOT_FOUND", "Commit does not exist");
  }
  let out: string;
  try {
    out = await rgit(worktreeDir, {}).raw([
      "show",
      "-s",
      "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s",
      sha,
    ]);
  } catch {
    throw new GitError("GIT_COMMIT_NOT_FOUND", "Commit does not exist");
  }
  const [full = "", short = "", authorName = "", authorEmail = "", at = "", parents = "", message = ""] =
    String(out).split("\n")[0]?.split("\x1f") ?? [];
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(full)) {
    throw new GitError("GIT_COMMIT_NOT_FOUND", "Commit does not exist");
  }
  return {
    sha: full,
    shortSha: short || full.slice(0, 7),
    message,
    authorName,
    authorEmail,
    timestamp: new Date(Number.parseInt(at || "0", 10) * 1000).toISOString(),
    parents: parents.split(" ").map((p) => p.trim()).filter((p) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(p)),
  };
}

export interface CommitFileChange {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  additions?: number;
  deletions?: number;
  binary: boolean;
}

/** Parse `git diff --numstat` rename forms (`old => new`, `{a => b}`). Pure. */
export function parseRenamePaths(p: string): { oldPath?: string; path: string } {
  const arrow = p.indexOf(" => ");
  if (arrow === -1) return { path: p };
  const left = p.slice(0, arrow);
  const right = p.slice(arrow + 4);
  const open = left.indexOf("{");
  const close = right.indexOf("}");
  if (open !== -1 && close !== -1) {
    const prefix = left.slice(0, open);
    const suffix = right.slice(close + 1);
    return {
      oldPath: `${prefix}${left.slice(open + 1)}${suffix}`,
      path: `${prefix}${right.slice(0, close)}${suffix}`,
    };
  }
  return { oldPath: left, path: right };
}

/**
 * Changed files for one commit. Statuses come from `--name-status`
 * (numstat alone cannot tell added apart from modified-with-only-additions);
 * counts/binary come from `--numstat`, correlated by new path.
 * Base = first parent, or the empty tree for root commits — merges compare
 * against their first parent; documented limitation.
 */
export async function commitFileChanges(
  worktreeDir: string,
  sha: string,
): Promise<{ parents: string[]; files: CommitFileChange[] }> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
    throw new GitError("GIT_COMMIT_NOT_FOUND", "Commit does not exist");
  }
  let parents: string[] = [];
  try {
    const rawParents = await rgit(worktreeDir, {}).raw(["rev-list", "--parents", "-n", "1", sha]);
    const parts = String(rawParents).trim().split(/\s+/).filter(Boolean);
    if (parts[0] !== sha) throw new Error("rev-list mismatch");
    parents = parts.slice(1);
  } catch (err) {
    if (err instanceof GitError) throw err;
    throw new GitError("GIT_COMMIT_NOT_FOUND", "Commit does not exist");
  }
  const base = parents[0] ?? EMPTY_TREE_SHA;
  let statusOut: string;
  let numstatOut: string;
  try {
    const g = rgit(worktreeDir, {});
    [statusOut, numstatOut] = await Promise.all([
      g.raw(["diff", "--name-status", "--find-renames", base, sha, "--"]),
      g.raw(["diff", "--numstat", "--find-renames", base, sha, "--"]),
    ]);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[git:commit-files]", sanitizeRemoteMessage(raw).slice(0, 300));
    throw new GitError("GIT_OPERATION_FAILED", "Could not read commit changes");
  }
  // Counts keyed by new path (rename forms resolved via parseRenamePaths).
  const counts = new Map<string, { additions?: number; deletions?: number; binary: boolean }>();
  for (const line of String(numstatOut).split("\n")) {
    if (!line.trim()) continue;
    const tab = line.split("\t");
    if (tab.length < 3) continue;
    const [addsRaw = "", delsRaw = "", ...rest] = tab;
    const { path } = parseRenamePaths(rest.join("\t"));
    const binary = addsRaw === "-" || delsRaw === "-";
    const additions = binary ? undefined : Number.parseInt(addsRaw, 10);
    const deletions = binary ? undefined : Number.parseInt(delsRaw, 10);
    counts.set(path, {
      ...(additions === undefined || Number.isNaN(additions) ? {} : { additions }),
      ...(deletions === undefined || Number.isNaN(deletions) ? {} : { deletions }),
      binary,
    });
  }
  const files: CommitFileChange[] = [];
  for (const line of String(statusOut).split("\n")) {
    if (!line.trim()) continue;
    const tab = line.split("\t");
    const code = tab[0] ?? "";
    const kind = code[0] ?? "";
    let status: GitFileStatus;
    let path: string;
    let oldPath: string | undefined;
    if (kind === "R") {
      status = "renamed";
      oldPath = tab[1] ?? "";
      path = tab[2] ?? "";
    } else if (kind === "C") {
      status = "copied";
      oldPath = tab[1] ?? "";
      path = tab[2] ?? "";
    } else if (kind === "A") {
      status = "added";
      path = tab[1] ?? "";
    } else if (kind === "D") {
      status = "deleted";
      path = tab[1] ?? "";
    } else if (kind === "M" || kind === "T") {
      status = "modified";
      path = tab[1] ?? "";
    } else {
      continue;
    }
    if (!path) continue;
    const count = counts.get(path) ?? { binary: false };
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status,
      ...(count.additions === undefined ? {} : { additions: count.additions }),
      ...(count.deletions === undefined ? {} : { deletions: count.deletions }),
      binary: count.binary,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { parents, files };
}

export interface HistoryDiff {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  sha: string;
  isBinary: boolean;
  tooLarge: boolean;
  oldContent: string | null;
  newContent: string | null;
}

/** Parent → commit file diff (first parent for merges). */
export async function historyFileDiff(
  worktreeDir: string,
  sha: string,
  repoPath: string,
): Promise<HistoryDiff> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
    throw new GitError("GIT_COMMIT_NOT_FOUND", "Commit does not exist");
  }
  const { parents, files } = await commitFileChanges(worktreeDir, sha);
  const entry = files.find((f) => f.path === repoPath);
  if (!entry) {
    throw new GitError("GIT_INVALID_PATH", "File was not changed by this commit");
  }
  const base = parents[0] ?? EMPTY_TREE_SHA;
  const showPath = entry.oldPath ?? repoPath;
  let oldContent: string | null = null;
  let newContent: string | null = null;
  if (entry.status !== "added") {
    try {
      const out = await rgit(worktreeDir, {}).raw(["show", `${base}:${showPath}`]);
      oldContent = typeof out === "string" ? out : null;
    } catch {
      oldContent = null;
    }
  }
  if (entry.status !== "deleted") {
    try {
      const out = await rgit(worktreeDir, {}).raw(["show", `${sha}:${repoPath}`]);
      newContent = typeof out === "string" ? out : null;
    } catch {
      newContent = null;
    }
  }
  if (entry.binary) {
    return { path: repoPath, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), status: entry.status, sha, isBinary: true, tooLarge: false, oldContent: null, newContent: null };
  }
  if (
    (oldContent !== null && oldContent.length > MAX_DIFF_BYTES) ||
    (newContent !== null && newContent.length > MAX_DIFF_BYTES)
  ) {
    return { path: repoPath, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), status: entry.status, sha, isBinary: false, tooLarge: true, oldContent: null, newContent: null };
  }
  if (
    (oldContent !== null && oldContent.includes("\0")) ||
    (newContent !== null && newContent.includes("\0"))
  ) {
    return { path: repoPath, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), status: entry.status, sha, isBinary: true, tooLarge: false, oldContent: null, newContent: null };
  }
  return { path: repoPath, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), status: entry.status, sha, isBinary: false, tooLarge: false, oldContent, newContent };
}
