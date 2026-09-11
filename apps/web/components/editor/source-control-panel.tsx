"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { gitErrorCode, gitService, type GitStatus, type GitStatusEntry } from "@/lib/git/service";
import {
  commitMessageError,
  displayPath,
  groupStatusEntries,
  panelState,
  statusBadge,
  statusCounts,
} from "@/lib/git/helpers";

interface SourceControlPanelProps {
  projectId: string;
  onOpenDiff: (path: string, staged: boolean) => void;
  /** Client-side backstop for the server dirty-editor guard. */
  isPathDirty?: (path: string) => boolean;
}

function friendlyError(err: unknown): { message: string; code?: string } {
  const message = err instanceof Error ? err.message : "Git operation failed";
  return { message, code: gitErrorCode(err) };
}

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

  useEffect(() => {
    setLoading(true);
    setStatus(null);
    setError(null);
    setNotConnected(false);
    setMessage("");
    void load();
  }, [projectId, load]);

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

  const handleInitialize = useCallback(async () => {
    setInitializing(true);
    try {
      await gitService.ensure(projectId);
      await load();
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
  }, [projectId, load]);

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
    }
  }, [message, projectId, runOp]);

  const state = panelState({ loading, notConnected, initializing, error, status });
  const counts = statusCounts(status);
  const groups = groupStatusEntries(status);

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
          onClick={() => onOpenDiff(entry.path, stagedView)}
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
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="font-mono text-muted-foreground" title="Current branch (read-only in Phase 4A)">
          {status?.branch ?? "—"}
        </span>
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
      </div>

      <div className="shrink-0 border-t p-3">
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
