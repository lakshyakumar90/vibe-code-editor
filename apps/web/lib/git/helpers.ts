import type { GitStatus, GitStatusEntry } from "./service";

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
