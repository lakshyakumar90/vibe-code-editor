"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

function GitHubLogo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.15c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.35.95.1-.74.4-1.25.72-1.53-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12v3.14c0 .3.2.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

interface Repo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  language: string | null;
}

export default function ImportPage() {
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [importing, setImporting] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const router = useRouter();

  async function search(query: string) {
    abort.current?.abort();
    const c = new AbortController();
    abort.current = c;
    setState("loading");
    try {
      const r = await api.get<{ success: boolean; data: Repo[] }>(
        `/api/github/repos?q=${encodeURIComponent(query)}`,
      );
      if (!c.signal.aborted) {
        setRepos(r.data);
        setState("ready");
      }
    } catch {
      if (!c.signal.aborted) setState("error");
    }
  }

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q === "") {
      void search("");
      return;
    }
    timer.current = setTimeout(() => void search(q), 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  async function doImport(r: Repo) {
    setImporting(r.fullName);
    try {
      const res = await api.post<{ success: boolean; data: { project: { id: string } } }>("/api/github/import", {
        owner: r.owner,
        repo: r.name,
        name: r.name,
      });
      router.push(`/dashboard/projects/${res.data.project.id}`);
    } catch {
      setState("error");
      setImporting(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex items-center gap-2">
        <GitHubLogo />
        <h1 className="text-2xl font-semibold">Import from GitHub</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Bring a supported repository (Next.js, Express, Hono, React, Angular, Vue) into Vibe. Import-only — no push or publish.
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search repositories…"
        className="mt-4 w-full rounded-md border bg-background px-3 py-2 text-sm"
        aria-label="Search GitHub repositories"
      />
      {state === "loading" && <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />)}</div>}
      {state === "error" && (
        <div className="mt-6 rounded-xl border p-6 text-center text-sm">
          Couldn&apos;t reach GitHub. <button onClick={() => void search(q)} className="text-primary underline">Retry</button>
        </div>
      )}
      {state === "ready" && repos.length === 0 && (
        <div className="mt-6 rounded-xl border p-8 text-center">
          <GitHubLogo className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No repositories found</p>
          <p className="text-xs text-muted-foreground">Connect GitHub in Settings or try another search.</p>
        </div>
      )}
      {state === "ready" && repos.length > 0 && (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {repos.map((r) => (
            <div key={r.fullName} className="rounded-xl border p-4">
              <div className="flex items-start gap-2">
                <GitHubLogo className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{r.fullName}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1 text-[11px]">
                    <span className="rounded-full bg-muted px-2 py-0.5">{r.private ? "Private" : "Public"}</span>
                    {r.language && <span className="rounded-full bg-muted px-2 py-0.5">{r.language}</span>}
                  </div>
                </div>
              </div>
              {r.description && <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{r.description}</p>}
              <button
                onClick={() => void doImport(r)}
                disabled={importing !== null}
                className="mt-3 w-full rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              >
                {importing === r.fullName ? "Importing…" : "Import"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
