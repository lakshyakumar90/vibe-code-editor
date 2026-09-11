"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button, Card, CardContent, Input, Skeleton } from "@repo/ui";
import { RepoCard } from "@/components/import/repo-card";
import {
  filterByTab,
  tabCounts,
  type DiscoveryTab,
  type InspectionState,
} from "@/lib/github/discovery";
import { githubService, type GitHubRepo, type RepoListMeta } from "@/lib/services/github";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 30;
/** Concurrent inspection requests per page (bounded GitHub fan-out). */
const INSPECT_CONCURRENCY = 4;

const TABS: { id: DiscoveryTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "supported", label: "Supported" },
  { id: "ambiguous", label: "Ambiguous" },
  { id: "unsupported", label: "Unsupported" },
];

export function ImportPage() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<DiscoveryTab>("all");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [meta, setMeta] = useState<RepoListMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [notConnected, setNotConnected] = useState(false);
  const [inspections, setInspections] = useState<Record<string, InspectionState>>({});
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async (pageNum: number, q: string) => {
    setLoading(true);
    try {
      const data = await githubService.listRepos({
        page: pageNum,
        perPage: PAGE_SIZE,
        q: q || undefined,
      });
      setRepos(data.repos);
      setMeta(data.meta);
      setNotConnected(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not load repositories";
      if (/connect github/i.test(message)) {
        setNotConnected(true);
        setRepos([]);
        setMeta(null);
      } else {
        toast.error(message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(page, debouncedQuery);
  }, [load, page, debouncedQuery]);

  // Bounded lazy inspection queue for the current page.
  useEffect(() => {
    if (repos.length === 0) return;
    let cancelled = false;
    const queue = repos
      .map((r) => r.fullName)
      .filter((f) => !inspections[f] && !inFlight.current.has(f));
    if (queue.length === 0) return;

    const workers = Array.from(
      { length: Math.min(INSPECT_CONCURRENCY, queue.length) },
      () => (async () => {
        while (!cancelled) {
          const fullName = queue.shift();
          if (!fullName) return;
          inFlight.current.add(fullName);
          setInspections((prev) =>
            prev[fullName] ? prev : { ...prev, [fullName]: { state: "checking" } },
          );
          try {
            const [owner, ...rest] = fullName.split("/");
            const inspection = await githubService.getInspection(owner!, rest.join("/"));
            if (!cancelled) {
              setInspections((prev) => ({ ...prev, [fullName]: { state: "ready", inspection } }));
            }
          } catch (err: unknown) {
            if (!cancelled) {
              setInspections((prev) => ({
                ...prev,
                [fullName]: {
                  state: "error",
                  message: err instanceof Error ? err.message : "Inspection failed",
                },
              }));
            }
          } finally {
            inFlight.current.delete(fullName);
          }
        }
      })(),
    );
    void Promise.all(workers);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos]);

  if (notConnected) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Import from GitHub</h1>
          <p className="text-sm text-muted-foreground">
            Connect GitHub to browse repositories you can import.
          </p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-start gap-3 pt-6">
            <p className="text-sm">GitHub is not connected.</p>
            <Link href="/dashboard/settings">
              <Button>Connect GitHub</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const counts = tabCounts(repos, inspections);
  const visible = filterByTab(repos, inspections, tab);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Import from GitHub</h1>
        <p className="text-sm text-muted-foreground">
          Only Next.js, Express, Hono, React, Angular and Vue repositories can be imported.
        </p>
      </div>

      <Input
        placeholder="Search repositories…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search repositories"
      />

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Repository filter">
        {TABS.map((t) => (
          <Button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            variant={tab === t.id ? "default" : "outline"}
            size="sm"
            onClick={() => setTab(t.id)}
            className={cn(tab === t.id && "font-medium")}
          >
            {t.label} ({counts[t.id]})
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No repositories match this filter.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {visible.map((repo) => (
            <RepoCard
              key={repo.fullName}
              repo={repo}
              inspection={inspections[repo.fullName] ?? { state: "pending" }}
            />
          ))}
        </div>
      )}

      {!loading && meta && !meta.filtered ? (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">Page {meta.page}</span>
          <Button variant="outline" disabled={!meta.hasNextPage} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
