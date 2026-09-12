import type { GitStatus, GitStatusEntry, RemoteCapability } from "./service";

/**
 * Phase 4A — pure Source Control view helpers (unit-tested; the panel
 * stays a thin renderer). Display never relies on color alone — every
 * entry carries a deterministic single-letter badge.
 */

export const STATUS_BADGES: Record<GitStatusEntry["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "?",
  conflicted: "!",
};

export function statusBadge(status: GitStatusEntry["status"]): string {
  return STATUS_BADGES[status] ?? "?";
}

export function displayPath(entry: GitStatusEntry): string {
  return entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
}

export interface StatusGroups {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
}

/**
 * Split status entries into STAGED CHANGES vs CHANGES. An entry with both
 * sides dirty appears in both groups (staged snapshot + worktree delta),
 * matching the requested Zed-like structure.
 */
export function groupStatusEntries(status: GitStatus | null | undefined): StatusGroups {
  if (!status) return { staged: [], unstaged: [] };
  const staged = status.entries.filter((e) => e.staged);
  const unstaged = status.entries.filter(
    (e) => e.unstaged || e.status === "untracked",
  );
  return { staged, unstaged };
}

export function statusCounts(status: GitStatus | null | undefined): {
  staged: number;
  unstaged: number;
  total: number;
} {
  const { staged, unstaged } = groupStatusEntries(status);
  return { staged: staged.length, unstaged: unstaged.length, total: status?.totalCount ?? 0 };
}

/** Commit message validation mirrors the server (1–2000 chars trimmed). */
export function commitMessageError(message: string): string | null {
  if (message.trim().length === 0) return "Enter a commit message";
  if (message.trim().length > 2000) return "Commit message must be at most 2000 characters";
  return null;
}

/** Compact ahead/behind label (`↑ 2 ↓ 1`), null when in sync. Pure. */
export function aheadBehindLabel(ahead: number, behind: number): string | null {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** UI copy per remote capability (never implies push where denied). Pure. */
export function capabilityCopy(capability: RemoteCapability): {
  remoteLine: string;
  pushAvailable: boolean;
  remoteActions: boolean;
} {
  switch (capability) {
    case "LOCAL_ONLY":
      return {
        remoteLine: "Local Git repository",
        pushAvailable: false,
        remoteActions: false,
      };
    case "CONNECTED_READONLY":
      return {
        remoteLine: "Push unavailable — GitHub write permission is required",
        pushAvailable: false,
        remoteActions: true,
      };
    case "CONNECTED_WRITE":
      return { remoteLine: "", pushAvailable: true, remoteActions: true };
    case "REMOTE_UNAVAILABLE":
      return { remoteLine: "Remote unavailable", pushAvailable: false, remoteActions: false };
    case "REAUTH_REQUIRED":
      return {
        remoteLine: "GitHub connection expired",
        pushAvailable: false,
        remoteActions: false,
      };
  }
}

/**
 * Client mirror of the server branch-name rules (instant feedback only —
 * the server re-validates authoritatively). Pure.
 */
export function branchNameError(name: string): string | null {
  if (name.length === 0) return "Enter a branch name";
  if (name.length > 128) return "Branch name is too long";
  if (name === "HEAD") return "HEAD is reserved";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\\]]/.test(name)) return "Branch name contains invalid characters";
  if (name.includes("..") || name.includes("@{") || name.includes("@")) {
    return "Branch name contains an invalid sequence";
  }
  if (name.includes("//")) return "Branch name contains an empty segment";
  if (name === "refs" || name.startsWith("refs/")) return "Branch name may not start with refs/";
  const segs = name.split("/");
  for (const s of segs) {
    if (s.length === 0 || s === "." || s === "..") return "Branch name has an empty segment";
    if (s.startsWith(".") || s.startsWith("-")) return "Branch segments may not start with . or -";
    if (s.endsWith(".") || s.endsWith(".lock")) return "Branch segments may not end with . or .lock";
  }
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) {
    return "Branch name has an invalid edge";
  }
  return null;
}

/** Short relative time for history rows ("2 min ago"). Pure. */
export function formatCommitTime(iso: string, nowMs = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.floor(months / 12)} year${Math.floor(months / 12) === 1 ? "" : "s"} ago`;
}

/** Human state for the panel header / empty states. */
export function panelState(input: {
  loading: boolean;
  notConnected: boolean;
  initializing: boolean;
  error: string | null;
  status: GitStatus | null;
}): "loading" | "not-connected" | "initializing" | "error" | "clean" | "changes" {
  if (input.loading) return "loading";
  if (input.notConnected) return "not-connected";
  if (input.initializing) return "initializing";
  if (input.error) return "error";
  if (!input.status || (input.status.clean && input.status.entries.length === 0)) return "clean";
  return "changes";
}
