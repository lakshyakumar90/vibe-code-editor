"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { gitErrorCode, gitService } from "@/lib/git/service";
import type { RemoteState } from "@/lib/git/service";
import { repoNameError, suggestRepoName } from "@/lib/git/helpers";
import { githubService } from "@/lib/services/github";
import { projectService } from "@/lib/services/projects";

interface PublishDialogProps {
  projectId: string;
  onClose: () => void;
  onPublished: (result: { fullName: string; remote: RemoteState }) => void;
}

function errorCopy(code: string | undefined, fallback: string): string {
  switch (code) {
    case "GITHUB_REPO_ALREADY_EXISTS":
      return fallback + " Choose another name, or attach the existing repository via Add Remote.";
    case "GITHUB_REPO_CREATE_DENIED":
      return "GitHub denied repository creation for this account.";
    case "GITHUB_REPO_CREATE_FAILED":
      return "Could not create the GitHub repository. Try again shortly.";
    case "GIT_REMOTE_ALREADY_CONFIGURED":
      return fallback;
    case "GIT_GITHUB_REAUTH_REQUIRED":
      return "GitHub authentication expired. Reconnect GitHub and retry.";
    default:
      return fallback;
  }
}

export function PublishDialog({ projectId, onClose, onPublished }: PublishDialogProps) {
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [owner, setOwner] = useState("");
  const [orgs, setOrgs] = useState<string[]>([]);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Suggest a repo name from the project title (once, until the user types).
  useEffect(() => {
    let cancelled = false;
    projectService
      .getProjectById(projectId)
      .then((project) => {
        if (cancelled || !mountedRef.current) return;
        setName((prev) => (prev === "" ? suggestRepoName(project?.name) : prev));
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        setName((prev) => (prev === "" ? "my-project" : prev));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Owner options: personal account + organizations. Personal-only fallback
  // when org listing fails (never blocks publishing).
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([githubService.listOrgs(), githubService.getStatus()]).then((results) => {
      if (cancelled || !mountedRef.current) return;
      const [orgsResult, statusResult] = results;
      if (orgsResult.status === "fulfilled") {
        setOrgs(orgsResult.value.orgs);
      } else {
        setOrgsFailed(true);
      }
      if (statusResult.status === "fulfilled") {
        setGithubLogin(statusResult.value.githubUser?.login ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const validation = repoNameError(name.trim());
  const canPublish = validation === null && !publishing;

  const handlePublish = useCallback(async () => {
    const trimmed = name.trim();
    const error = repoNameError(trimmed);
    if (error || publishing) {
      if (error) toast.error(error);
      return;
    }
    setPublishing(true);
    try {
      const result = await gitService.publish(projectId, {
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        private: isPrivate,
        ...(owner ? { organization: owner } : {}),
      });
      toast.success(`Published to ${result.fullName} — branch ${result.push.branch} pushed`);
      onPublished(result);
    } catch (err) {
      const code = gitErrorCode(err);
      toast.error(errorCopy(code, err instanceof Error ? err.message : "Could not publish"));
    } finally {
      if (mountedRef.current) setPublishing(false);
    }
  }, [name, description, isPrivate, owner, publishing, projectId, onPublished]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Publish to GitHub"
      >
        <div className="border-b p-4">
          <h2 className="text-sm font-semibold">Publish to GitHub</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Creates a new repository, attaches it, and pushes the current branch.
          </p>
        </div>

        <div className="space-y-3 p-4">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Repository name</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="my-project"
              maxLength={100}
              className="w-full rounded border bg-background px-2 py-1.5 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
            />
            {nameTouched && validation && <span className="mt-1 block text-[11px] text-red-500">{validation}</span>}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Description (optional)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              placeholder="What is this project about?"
              className="w-full rounded border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
            />
          </label>

          <fieldset>
            <legend className="mb-1 text-xs text-muted-foreground">Visibility</legend>
            <div className="flex gap-4 text-xs">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" checked={isPrivate} onChange={() => setIsPrivate(true)} />
                Private
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" checked={!isPrivate} onChange={() => setIsPrivate(false)} />
                Public
              </label>
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Owner</span>
            <select
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              className="w-full rounded border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
            >
              <option value="">
                {githubLogin ? `${githubLogin} (personal)` : "Your GitHub account (personal)"}
              </option>
              {orgs.map((org) => (
                <option key={org} value={org}>
                  {org} (organization)
                </option>
              ))}
            </select>
            {orgsFailed && (
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Could not load organizations — publishing to your personal account.{" "}
                <Link href="/dashboard/settings" className="underline hover:text-foreground">
                  Check GitHub connection
                </Link>
              </span>
            )}
          </label>
        </div>

        <div className="flex gap-2 border-t p-3">
          <button
            onClick={onClose}
            disabled={publishing}
            className="flex-1 rounded border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handlePublish}
            disabled={!canPublish}
            className="flex-1 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            title={validation ?? "Create repository and push"}
          >
            {publishing ? "Publishing…" : "Publish"}
          </button>
        </div>
        {publishing && (
          <p className="px-4 pb-3 text-[11px] text-muted-foreground">
            Creating repository, attaching remote, and pushing…
          </p>
        )}
      </div>
    </div>
  );
}
