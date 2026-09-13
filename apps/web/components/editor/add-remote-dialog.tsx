"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { gitErrorCode, gitService, type RemoteState } from "@/lib/git/service";
import { accessLabel } from "@/lib/github/discovery";
import { githubService, type GitHubRepo } from "@/lib/services/github";

interface AddRemoteDialogProps {
  projectId: string;
  onClose: () => void;
  onAttached: (result: { attached: boolean; empty: boolean; branch: string; remote: RemoteState }) => void;
}

function errorCopy(code: string | undefined, fallback: string): string {
  switch (code) {
    case "GIT_REMOTE_NOT_WRITABLE":
      return "Push requires write access — choose a repository you can write to.";
    case "GIT_REMOTE_HISTORY_CONFLICT":
      return (
        "This repository already contains unrelated history. The IDE never merges or " +
        "overwrites automatically — use an empty repository instead."
      );
    case "GIT_REMOTE_ALREADY_CONFIGURED":
      return fallback;
    case "GIT_GITHUB_REAUTH_REQUIRED":
      return "GitHub authentication expired. Reconnect GitHub and retry.";
    case "GIT_REMOTE_UNAVAILABLE":
      return "Repository unavailable or not accessible with this GitHub authorization.";
    default:
      return fallback;
  }
}

export function AddRemoteDialog({ projectId, onClose, onAttached }: AddRemoteDialogProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query]);

  const loadRepos = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const result = await githubService.listRepos({ perPage: 100, ...(q ? { q } : {}) });
      if (!mountedRef.current) return;
      setRepos(result.repos);
      setLoadError(null);
      setSelected((prev) => (prev && result.repos.some((r) => r.fullName === prev) ? prev : null));
    } catch (err) {
      if (!mountedRef.current) return;
      setRepos([]);
      setLoadError({
        message: err instanceof Error ? err.message : "Could not load repositories",
        code: gitErrorCode(err),
      });
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRepos(debouncedQuery);
  }, [debouncedQuery, loadRepos]);

  const handleAttach = useCallback(async () => {
    const repo = repos.find((r) => r.fullName === selected);
    if (!repo || attaching) return;
    const [owner, name] = repo.fullName.split("/");
    if (!owner || !name) return;
    setAttaching(true);
    try {
      const result = await gitService.attachRemote(projectId, { owner, repo: name });
      toast.success(
        result.empty
          ? `Remote added — push ${result.branch} to send your commits`
          : `Attached ${repo.fullName}`,
      );
      onAttached(result);
    } catch (err) {
      const code = gitErrorCode(err);
      toast.error(errorCopy(code, err instanceof Error ? err.message : "Could not attach remote"));
    } finally {
      if (mountedRef.current) setAttaching(false);
    }
  }, [repos, selected, attaching, projectId, onAttached]);

  const notConnected = loadError?.code === "GITHUB_NOT_CONNECTED";
  const selectedRepo = repos.find((r) => r.fullName === selected) ?? null;
  const canAttach = selectedRepo?.access.canWrite === true && !attaching;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Add GitHub remote"
      >
        <div className="border-b p-4">
          <h2 className="text-sm font-semibold">Add GitHub Remote</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Attach an existing repository. Nothing is pushed until you click Push.
          </p>
        </div>

        <div className="border-b p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repositories…"
            className="w-full rounded border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <p className="p-4 text-center text-xs text-muted-foreground">Loading repositories…</p>
          ) : loadError ? (
            <div className="p-4 text-center text-xs">
              <p className="text-muted-foreground">{loadError.message}</p>
              {notConnected && (
                <Link href="/dashboard/settings" className="mt-2 inline-block underline hover:text-foreground">
                  Connect GitHub
                </Link>
              )}
            </div>
          ) : repos.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">No repositories found.</p>
          ) : (
            repos.map((repo) => {
              const writable = repo.access.canWrite;
              return (
                <button
                  key={repo.fullName}
                  disabled={!writable}
                  onClick={() => setSelected(repo.fullName)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected === repo.fullName ? "bg-accent" : ""
                  }`}
                  title={writable ? `Attach ${repo.fullName}` : `${repo.fullName} — read access only`}
                >
                  <span
                    className={`flex size-3.5 shrink-0 items-center justify-center rounded-full border ${
                      selected === repo.fullName ? "border-primary" : "border-muted-foreground"
                    }`}
                  >
                    {selected === repo.fullName && <span className="size-1.5 rounded-full bg-primary" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono">{repo.fullName}</span>
                    <span className="block text-[11px] text-muted-foreground">{accessLabel(repo)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex gap-2 border-t p-3">
          <button
            onClick={onClose}
            disabled={attaching}
            className="flex-1 rounded border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleAttach}
            disabled={!canAttach}
            className="flex-1 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            title={
              !selected
                ? "Select a repository first"
                : selectedRepo && !selectedRepo.access.canWrite
                  ? "Push requires write access to this repository"
                  : "Verify and attach this repository"
            }
          >
            {attaching ? "Verifying repository…" : "Attach"}
          </button>
        </div>
      </div>
    </div>
  );
}
