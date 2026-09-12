"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  gitErrorCode,
  gitService,
  type BranchList,
  type CommitDetail,
  type GitStatus,
  type GitStatusEntry,
  type HistoryCommit,
  type RemoteState,
} from "@/lib/git/service";
import {
  aheadBehindLabel,
  branchNameError,
  capabilityCopy,
  commitMessageError,
  displayPath,
  formatCommitTime,
  groupStatusEntries,
  panelState,
  statusBadge,
  statusCounts,
} from "@/lib/git/helpers";

interface SourceControlPanelProps {
  projectId: string;
  onOpenDiff: (path: string, mode: { staged: boolean } | { sha: string }) => void;
  /** Client-side backstop for the server dirty-editor guard. */
  isPathDirty?: (path: string) => boolean;
}

function friendlyError(err: unknown): { message: string; code?: string } {
  const message = err instanceof Error ? err.message : "Git operation failed";
  return { message, code: gitErrorCode(err) };
}

const REMOTE_ERROR_TOASTS: Record<string, "info" | "error"> = {
  GIT_PULL_DIVERGED: "info",
  GIT_PUSH_REJECTED: "info",
  GIT_PUSH_DENIED: "error",
  GIT_REMOTE_UNAVAILABLE: "error",
  GIT_GITHUB_REAUTH_REQUIRED: "error",
  GIT_REMOTE_TIMEOUT: "error",
  GIT_REMOTE_MISMATCH: "error",
  GIT_NO_UPSTREAM: "info",
  GIT_DIRTY_WORKTREE: "error",
  GIT_BRANCH_EXISTS: "error",
  GIT_BRANCH_NOT_FOUND: "error",
  GIT_IMPORT_ROOT_UNKNOWN: "error",
};

export function SourceControlPanel({ projectId, onOpenDiff, isPathDirty }: SourceControlPanelProps) {
  const checkLocalDirty = (path: string): boolean => {
    if (isPathDirty?.(path)) {
      toast.error("Save open editors before discarding");
      return true;
    }
    return false;
  };
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [notConnected, setNotConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Phase 4B state.
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [showBranches, setShowBranches] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchFrom, setNewBranchFrom] = useState("HEAD");
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryCommit[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<CommitDetail | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await gitService.getStatus(projectId);
      if (!mountedRef.current) return;
      setStatus(next);
      setNotConnected(false);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      const { message: msg, code } = friendlyError(err);
      if (code === "GIT_NOT_CONNECTED") {
        setNotConnected(true);
        setStatus(null);
      } else {
        setError(msg);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [projectId]);

  const loadRemote = useCallback(async () => {
    try {
      const next = await gitService.getRemote(projectId);
      if (mountedRef.current) setRemote(next);
    } catch {
      // Remote state is progressive enhancement; status stays authoritative.
      if (mountedRef.current) setRemote(null);
    }
  }, [projectId]);

  const loadBranches = useCallback(async () => {
    try {
      const next = await gitService.listBranches(projectId);
      if (mountedRef.current) setBranches(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load branches");
    }
  }, [projectId]);

  const loadHistory = useCallback(
    async (cursor: string | null, append: boolean) => {
      setHistoryLoading(true);
      try {
        const page = await gitService.getHistory(projectId, {
          branch: status?.branch,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        if (!mountedRef.current) return;
        setHistory((prev) => (append ? [...prev, ...page.commits] : page.commits));
        setHistoryHasMore(page.hasMore);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not load history");
      } finally {
        if (mountedRef.current) setHistoryLoading(false);
      }
    },
    [projectId, status?.branch],
  );

  useEffect(() => {
    setLoading(true);
    setStatus(null);
    setError(null);
    setNotConnected(false);
    setMessage("");
    setRemote(null);
    setBranches(null);
    setHistory([]);
    setSelectedCommit(null);
    void load();
    void loadRemote();
  }, [projectId, load, loadRemote]);

  // Refresh on file-tree hints (saves, creates, deletes, AI applies,
  // discards) — debounced; manual refresh + post-op reloads cover the rest.
  // No permanent polling loop.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onHint = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 800);
    };
    window.addEventListener("vibe:file-tree", onHint);
    return () => {
      window.removeEventListener("vibe:file-tree", onHint);
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const runOp = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, applyStatus?: (result: T) => GitStatus | null) => {
      setBusy(label);
      setError(null);
      try {
        const result = await fn();
        const next = applyStatus?.(result) ?? null;
        if (next && mountedRef.current) setStatus(next);
        else await load();
        return result;
      } catch (err) {
        const { message: msg, code } = friendlyError(err);
        if (code === "GIT_OPERATION_IN_PROGRESS") {
          toast.info("A Git operation is already running — retry in a moment");
        } else if (code === "GIT_DIRTY_EDITOR_STATE") {
          toast.error("Save open editors before discarding");
          if (mountedRef.current) setError(msg);
        } else if (code && code in REMOTE_ERROR_TOASTS) {
          if (REMOTE_ERROR_TOASTS[code] === "info") toast.info(msg);
          else toast.error(msg);
          if (mountedRef.current) setError(msg);
        } else {
          toast.error(msg);
          if (mountedRef.current) setError(msg);
        }
        return null;
      } finally {
        if (mountedRef.current) {
          setBusy(null);
          setConfirmTarget(null);
        }
      }
    },
    [load],
  );

  const refreshAfterRemoteOp = useCallback(async () => {
    await load();
    await loadRemote();
  }, [load, loadRemote]);

  const handleInitialize = useCallback(async () => {
    setInitializing(true);
    try {
      await gitService.ensure(projectId);
      await load();
      await loadRemote();
      toast.success("Git repository ready");
    } catch (err) {
      const { message: msg, code } = friendlyError(err);
      if (code === "GIT_NOT_CONNECTED") {
        setNotConnected(true);
      } else {
        toast.error(msg);
      }
    } finally {
      if (mountedRef.current) setInitializing(false);
    }
  }, [projectId, load, loadRemote]);

  const handleCommit = useCallback(async () => {
    const validation = commitMessageError(message);
    if (validation) {
      toast.error(validation);
      return;
    }
    const result = await runOp("commit", () => gitService.commit(projectId, message.trim()), (r) => r.status);
    if (result) {
      setMessage("");
      setLastCommit(`Committed ${result.commit.sha.slice(0, 7)} — ${result.commit.message}`);
      toast.success("Committed");
      if (showHistory) void loadHistory(null, false);
    }
  }, [message, projectId, runOp, showHistory, loadHistory]);

  const handleFetch = useCallback(async () => {
    const result = await runOp("fetch", () => gitService.fetch(projectId));
    if (result) {
      await refreshAfterRemoteOp();
      toast.success("Fetched remote refs");
    }
  }, [projectId, runOp, refreshAfterRemoteOp]);

  const handlePull = useCallback(async () => {
    const result = await runOp("pull", () => gitService.pull(projectId), (r) => r.status);
    if (result) {
      await refreshAfterRemoteOp();
      toast.success(result.pulled ? "Pulled latest changes" : "Already up to date");
    }
  }, [projectId, runOp, refreshAfterRemoteOp]);

  const handlePush = useCallback(async () => {
    const result = await runOp("push", () => gitService.push(projectId));
    if (result) {
      await refreshAfterRemoteOp();
      toast.success(`Pushed ${result.branch} to origin`);
    }
  }, [projectId, runOp, refreshAfterRemoteOp]);

  const handleCheckout = useCallback(
    async (name: string) => {
      const result = await runOp(`checkout:${name}`, () => gitService.checkout(projectId, name), (r) => r.status);
      if (result) {
        toast.success(`Switched to ${result.branch}`);
        void loadBranches();
      }
    },
    [projectId, runOp, loadBranches],
  );

  const handleCreateBranch = useCallback(async () => {
    const trimmed = newBranchName.trim();
    const validation = branchNameError(trimmed);
    if (validation) {
      toast.error(validation);
      return;
    }
    const result = await runOp("create-branch", () =>
      gitService.createBranch(projectId, trimmed, newBranchFrom === "HEAD" ? undefined : newBranchFrom),
    );
    if (result) {
      setNewBranchName("");
      setNewBranchFrom("HEAD");
      toast.success(`Created branch ${result.branch.name}`);
      void loadBranches();
    }
  }, [newBranchName, newBranchFrom, projectId, runOp, loadBranches]);

  const handleOpenCommit = useCallback(
    async (sha: string) => {
      try {
        const detail = await gitService.getCommit(projectId, sha);
        if (mountedRef.current) setSelectedCommit(detail);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not load commit");
      }
    },
    [projectId],
  );

  const state = panelState({ loading, notConnected, initializing, error, status });
  const counts = statusCounts(status);
  const groups = groupStatusEntries(status);
  const capability = remote?.capability ?? null;
  const copy = capability ? capabilityCopy(capability) : null;
  const syncLabel = status ? aheadBehindLabel(status.ahead, status.behind) : null;

  if (state === "loading") {
    return <div className="p-4 text-sm text-muted-foreground">Loading Git status…</div>;
  }

  if (state === "not-connected") {
    return (
      <div className="flex flex-col gap-2 p-4 text-sm">
        <p className="font-medium">Source Control</p>
        <p className="text-muted-foreground">Git is not configured for this project.</p>
        <button
          onClick={handleInitialize}
          disabled={initializing}
          className="rounded border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          {initializing ? "Initializing…" : "Initialize repository"}
        </button>
      </div>
    );
  }

  const entryRow = (entry: GitStatusEntry, stagedView: boolean) => {
    const key = `${stagedView ? "staged" : "unstaged"}:${entry.path}`;
    const canDiscard = entry.status !== "untracked";
    return (
      <div key={key} className="group flex items-center gap-1.5 rounded px-2 py-1 text-[13px] hover:bg-accent/50">
        <span
          className="w-4 shrink-0 text-center font-mono text-xs text-muted-foreground"
          title={entry.status}
        >
          {statusBadge(entry.status)}
        </span>
        <button
          onClick={() => onOpenDiff(entry.path, { staged: stagedView })}
          className="min-w-0 flex-1 truncate text-left hover:underline"
          title={stagedView ? `Open staged diff for ${displayPath(entry)}` : `Open diff for ${displayPath(entry)}`}
        >
          {displayPath(entry)}
        </button>
        {stagedView ? (
          <button
            onClick={() => void runOp(`unstage:${entry.path}`, () => gitService.unstage(projectId, [entry.path]), (r) => r)}
            disabled={busy !== null}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            title={`Unstage ${entry.path}`}
            aria-label={`Unstage ${entry.path}`}
          >
            −
          </button>
        ) : (
          <button
            onClick={() => void runOp(`stage:${entry.path}`, () => gitService.stage(projectId, [entry.path]), (r) => r)}
            disabled={busy !== null}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            title={`Stage ${entry.path}`}
            aria-label={`Stage ${entry.path}`}
          >
            +
          </button>
        )}
        {canDiscard ? (
          confirmTarget === key ? (
            <span className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => {
                  if (checkLocalDirty(entry.path)) return;
                  void runOp(`discard:${entry.path}`, () => gitService.discard(projectId, [entry.path]), (r) => r.status).then(
                    (r) => {
                      if (r) toast.success(`Discarded ${entry.path}`);
                    },
                  );
                }}
                disabled={busy !== null}
                className="rounded bg-destructive px-1.5 py-0.5 text-[11px] text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                title={`Confirm discard of ${entry.path} (saved content reverts to HEAD)`}
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmTarget(null)}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmTarget(key)}
              disabled={busy !== null}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              title={`Discard changes to ${entry.path}`}
              aria-label={`Discard changes to ${entry.path}`}
            >
              ↩
            </button>
          )
        ) : (
          <span
            className="shrink-0 rounded p-1 text-muted-foreground/40"
            title="Untracked files are never discarded — delete the file to remove it"
          >
            ↩
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-2 text-xs">
        <select
          value={status?.branch ?? ""}
          onChange={(e) => {
            const name = e.target.value;
            if (name && name !== status?.branch) void handleCheckout(name);
          }}
          disabled={busy !== null || !branches}
          onFocus={() => {
            if (!branches) void loadBranches();
          }}
          className="max-w-[140px] truncate rounded bg-transparent px-1 py-1 font-mono text-muted-foreground outline-none hover:bg-accent hover:text-foreground disabled:opacity-50"
          title={branches ? "Switch branch" : "Open to load branches, then switch"}
          aria-label="Current branch"
        >
          <option value={status?.branch ?? ""}>{status?.branch ?? "—"}</option>
          {(branches?.local ?? [])
            .filter((b) => b.name !== status?.branch)
            .map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          {(branches?.remote ?? []).map((b) => (
            <option key={b.remoteName} value={b.remoteName}>
              {b.remoteName}
            </option>
          ))}
        </select>
        {syncLabel && (
          <span className="shrink-0 font-mono text-muted-foreground" title="Ahead/behind upstream">
            {syncLabel}
          </span>
        )}
        <span className="flex-1" />
        <button
          onClick={() => void load()}
          disabled={busy !== null}
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          title="Refresh Git status"
          aria-label="Refresh Git status"
        >
          ⟳
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state === "error" && (
          <div className="m-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {state === "clean" && (
          <div className="p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{status?.branch ?? ""}</p>
            <p className="mt-1">Working tree clean.</p>
          </div>
        )}

        {groups.staged.length > 0 && (
          <div className="border-b py-1">
            <div className="flex items-center gap-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Staged Changes</span>
              <span className="rounded bg-accent px-1.5">{counts.staged}</span>
              <span className="flex-1" />
              <button
                onClick={() => void runOp("unstage-all", () => gitService.unstageAll(projectId), (r) => r)}
                disabled={busy !== null}
                className="font-normal normal-case tracking-normal hover:text-foreground disabled:opacity-50"
                title="Unstage all"
              >
                Unstage All
              </button>
            </div>
            {groups.staged.map((e) => entryRow(e, true))}
          </div>
        )}

        {groups.unstaged.length > 0 && (
          <div className="py-1">
            <div className="flex items-center gap-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Changes</span>
              <span className="rounded bg-accent px-1.5">{counts.unstaged}</span>
              <span className="flex-1" />
              <button
                onClick={() => void runOp("stage-all", () => gitService.stageAll(projectId), (r) => r)}
                disabled={busy !== null}
                className="font-normal normal-case tracking-normal hover:text-foreground disabled:opacity-50"
                title="Stage all"
              >
                Stage All
              </button>
            </div>
            {groups.unstaged.map((e) => entryRow(e, false))}
          </div>
        )}

        {status?.truncated && (
          <p className="px-3 py-1 text-[11px] text-muted-foreground">
            Showing {status.entries.length} of {status.totalCount} changed files.
          </p>
        )}

        <div className="border-t py-1">
          <button
            onClick={() => {
              const next = !showBranches;
              setShowBranches(next);
              if (next && !branches) void loadBranches();
            }}
            className="flex w-full items-center gap-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
            aria-expanded={showBranches}
          >
            <span>Branches</span>
            {branches && <span className="rounded bg-accent px-1.5">{branches.local.length}</span>}
          </button>
          {showBranches && (
            <div className="px-2 pb-2">
              {!branches ? (
                <p className="px-1 py-1 text-xs text-muted-foreground">Loading branches…</p>
              ) : (
                <>
                  <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Local
                  </p>
                  {branches.local.map((b) => (
                    <div
                      key={b.name}
                      className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] hover:bg-accent/50"
                    >
                      <span className="w-4 shrink-0 text-center text-xs">
                        {b.current ? "●" : ""}
                      </span>
                      <button
                        onClick={() => {
                          if (!b.current) void handleCheckout(b.name);
                        }}
                        disabled={busy !== null || b.current}
                        className="min-w-0 flex-1 truncate text-left disabled:no-underline hover:underline disabled:opacity-70"
                        title={b.current ? `Current branch (${b.upstream ?? "no upstream"})` : `Switch to ${b.name}`}
                      >
                        {b.name}
                      </button>
                      {b.upstream && ((b.ahead ?? 0) > 0 || (b.behind ?? 0) > 0) ? (
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {(b.ahead ?? 0) > 0 ? `↑${b.ahead}` : ""}
                          {(b.ahead ?? 0) > 0 && (b.behind ?? 0) > 0 ? " " : ""}
                          {(b.behind ?? 0) > 0 ? `↓${b.behind}` : ""}
                        </span>
                      ) : null}
                    </div>
                  ))}
                  {branches.remote.length > 0 && (
                    <>
                      <p className="px-1 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Remote
                      </p>
                      {branches.remote.map((b) => (
                        <div
                          key={b.remoteName}
                          className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] hover:bg-accent/50"
                        >
                          <span className="w-4 shrink-0" />
                          <button
                            onClick={() => void handleCheckout(b.remoteName)}
                            disabled={busy !== null}
                            className="min-w-0 flex-1 truncate text-left text-muted-foreground hover:underline hover:text-foreground disabled:opacity-50"
                            title={`Check out ${b.remoteName} as a local tracking branch`}
                          >
                            {b.remoteName}
                          </button>
                        </div>
                      ))}
                      {branches.remoteTruncated && (
                        <p className="px-3 py-1 text-[11px] text-muted-foreground">
                          Remote branch list truncated.
                        </p>
                      )}
                    </>
                  )}
                  <div className="mt-2 flex gap-1.5 px-1">
                    <input
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      placeholder="New branch name…"
                      maxLength={128}
                      className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
                      aria-label="New branch name"
                    />
                    <button
                      onClick={handleCreateBranch}
                      disabled={busy !== null || branchNameError(newBranchName.trim()) !== null}
                      className="shrink-0 rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                      title="Create branch from HEAD"
                    >
                      {busy === "create-branch" ? "…" : "+ New"}
                    </button>
                  </div>
                  {newBranchName.trim() && branchNameError(newBranchName.trim()) && (
                    <p className="px-2 pt-1 text-[11px] text-destructive">
                      {branchNameError(newBranchName.trim())}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="border-t py-1">
          <button
            onClick={() => {
              const next = !showHistory;
              setShowHistory(next);
              setSelectedCommit(null);
              if (next && history.length === 0) void loadHistory(null, false);
            }}
            className="flex w-full items-center gap-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
            aria-expanded={showHistory}
          >
            <span>History</span>
          </button>
          {showHistory && (
            <div className="px-2 pb-2">
              {selectedCommit ? (
                <div>
                  <button
                    onClick={() => setSelectedCommit(null)}
                    className="px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    ← All commits
                  </button>
                  <p className="px-1 text-[13px] font-medium">{selectedCommit.message || "(no message)"}</p>
                  <p className="px-1 font-mono text-[11px] text-muted-foreground">
                    {selectedCommit.shortSha} · {selectedCommit.authorName} ·{" "}
                    {formatCommitTime(selectedCommit.timestamp)}
                  </p>
                  <div className="mt-1">
                    {selectedCommit.files.length === 0 && (
                      <p className="px-1 py-1 text-xs text-muted-foreground">No file changes.</p>
                    )}
                    {selectedCommit.files.map((f) => (
                      <div
                        key={f.path}
                        className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] hover:bg-accent/50"
                      >
                        <span
                          className="w-4 shrink-0 text-center font-mono text-xs text-muted-foreground"
                          title={f.status}
                        >
                          {f.status === "modified"
                            ? "M"
                            : f.status === "added"
                              ? "A"
                              : f.status === "deleted"
                                ? "D"
                                : f.status === "renamed"
                                  ? "R"
                                  : "?"}
                        </span>
                        <button
                          onClick={() => onOpenDiff(f.path, { sha: selectedCommit.sha })}
                          className="min-w-0 flex-1 truncate text-left hover:underline"
                          title={`Open diff for ${f.path} in ${selectedCommit.shortSha}`}
                        >
                          {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                        </button>
                        {typeof f.additions === "number" || typeof f.deletions === "number" ? (
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                            +{f.additions ?? 0} −{f.deletions ?? 0}
                          </span>
                        ) : f.binary ? (
                          <span className="shrink-0 text-[11px] text-muted-foreground">binary</span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {historyLoading && history.length === 0 ? (
                    <p className="px-1 py-1 text-xs text-muted-foreground">Loading history…</p>
                  ) : history.length === 0 ? (
                    <p className="px-1 py-1 text-xs text-muted-foreground">No commits yet.</p>
                  ) : (
                    history.map((c) => (
                      <div
                        key={c.sha}
                        className="flex items-center gap-1.5 rounded px-2 py-1 text-[13px] hover:bg-accent/50"
                      >
                        <button
                          onClick={() => void handleOpenCommit(c.sha)}
                          className="min-w-0 flex-1 truncate text-left hover:underline"
                          title={`${c.message}\n${c.sha}`}
                        >
                          <span className="block truncate">{c.message || "(no message)"}</span>
                          <span className="block font-mono text-[11px] text-muted-foreground">
                            {c.shortSha} · {formatCommitTime(c.timestamp)}
                          </span>
                        </button>
                      </div>
                    ))
                  )}
                  {historyHasMore && (
                    <button
                      onClick={() =>
                        void loadHistory(history.length > 0 ? history[history.length - 1]!.sha : null, true)
                      }
                      disabled={historyLoading}
                      className="mt-1 w-full rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                    >
                      {historyLoading ? "Loading…" : "Load more"}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t p-3">
        {remote && remote.importRootKnown === false && remote.capability !== "LOCAL_ONLY" && (
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            Push, pull, and fetch are disabled: this project&apos;s original import location is
            unknown. Re-import the repository to enable remote sync.
          </p>
        )}
        {copy && copy.remoteLine && (
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            {copy.remoteLine}
            {capability === "REAUTH_REQUIRED" && (
              <>
                {" "}
                <Link href="/dashboard/settings" className="underline hover:text-foreground">
                  Reconnect GitHub
                </Link>
              </>
            )}
          </p>
        )}
        {capability && copy && (copy.remoteActions || copy.pushAvailable) && (
          <div className="mb-2 flex gap-1.5">
            <button
              onClick={handleFetch}
              disabled={busy !== null}
              className="flex-1 rounded border px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              title="Fetch remote refs (never touches working files)"
            >
              {busy === "fetch" ? "Fetching…" : "Fetch"}
            </button>
            <button
              onClick={handlePull}
              disabled={busy !== null}
              className="flex-1 rounded border px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              title="Fast-forward pull (refuses when diverged or dirty)"
            >
              {busy === "pull" ? "Pulling…" : "Pull"}
            </button>
            <button
              onClick={handlePush}
              disabled={busy !== null || !copy.pushAvailable}
              className="flex-1 rounded border px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              title={
                copy.pushAvailable
                  ? "Push current branch to origin"
                  : "Push unavailable — GitHub write permission is required"
              }
            >
              {busy === "push" ? "Pushing…" : "Push"}
            </button>
          </div>
        )}
        {lastCommit && <p className="mb-1.5 truncate text-[11px] text-muted-foreground">{lastCommit}</p>}
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message…"
          rows={2}
          maxLength={2000}
          className="w-full resize-none rounded border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
        />
        <button
          onClick={handleCommit}
          disabled={busy !== null || commitMessageError(message) !== null}
          className="mt-2 w-full rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy === "commit" ? "Committing…" : "Commit"}
        </button>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Local commit only — nothing is pushed.
        </p>
      </div>
    </div>
  );
}
