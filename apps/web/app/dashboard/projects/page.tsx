"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FolderKanban, Star } from "lucide-react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { Card, CardContent, Skeleton } from "@repo/ui";
import { useProjects } from "@/hooks/use-projects";
import { FavoriteButton } from "@/components/projects/favorite-button";
import { DeleteProjectButton } from "@/components/projects/delete-project-button";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

type ProjectFilter = "all" | "starred" | "recent";

function parseFilter(value: string | null): ProjectFilter {
  return value === "starred" || value === "recent" ? value : "all";
}

const FILTER_META: Record<ProjectFilter, { title: string; emptyText: string }> = {
  all: { title: "Your Projects", emptyText: "Create your first project to get started." },
  starred: { title: "Starred projects", emptyText: "No starred projects yet. Star one to pin it here." },
  recent: { title: "Recent projects", emptyText: "No projects yet." },
};

function ProjectsList() {
  const searchParams = useSearchParams();
  const filter = parseFilter(searchParams.get("filter"));
  const meta = FILTER_META[filter];
  const { projects, loading, refetch, toggleFavorite } = useProjects();

  const visible =
    filter === "starred"
      ? projects.filter((p) => p.isFavorite)
      : filter === "recent"
        ? [...projects].sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          )
        : projects;

  if (loading) {
    return (
      <div className="p-6 mx-auto max-w-4xl">
        <div className="flex justify-between mb-6">
          <h1 className="text-2xl font-bold">{meta.title}</h1>
        </div>
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 mx-auto max-w-4xl">
      <div className="flex items-center gap-2 mb-6">
        {filter === "starred" && (
          <Star className="size-6 fill-yellow-500 text-yellow-500" />
        )}
        <h1 className="text-2xl font-bold">{meta.title}</h1>
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FolderKanban className="size-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">
              {filter === "all" ? "No projects yet" : "Nothing here"}
            </p>
            <p className="text-sm text-muted-foreground mb-4">{meta.emptyText}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {visible.map((project) => (
            <div
              key={project.id}
              className="flex items-center gap-4 border rounded-lg p-4 hover:bg-accent transition-colors"
            >
              <Link
                href={`/dashboard/projects/${project.id}`}
                className="flex min-w-0 flex-1 items-center gap-4"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/30">
                  <FolderKanban className="size-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{project.name}</p>
                  <p className="text-sm text-muted-foreground truncate">
                    {project.description || "No description"}
                  </p>
                </div>
              </Link>
              <div className="flex shrink-0 items-center gap-1">
                <FavoriteButton
                  projectId={project.id}
                  projectName={project.name}
                  isFavorite={project.isFavorite}
                  onToggle={toggleFavorite}
                />
                <DeleteProjectButton
                  projectId={project.id}
                  projectName={project.name}
                  onDeleted={refetch}
                />
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="flex -space-x-2">
                  {project.members.slice(0, 3).map((member) => (
                    <div
                      key={member.id}
                      className="flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-background bg-primary/10 text-xs font-medium"
                      title={member.user?.name || "Unknown"}
                    >
                      {getInitials(member.user?.name || "U")}
                    </div>
                  ))}
                  {project.members.length > 3 && (
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-background bg-muted text-xs font-medium">
                      +{project.members.length - 3}
                    </div>
                  )}
                </div>
                <span className="rounded-md border bg-muted/30 px-2 py-1 text-xs font-medium">
                  {project.template}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <AuthGuard>
      <Suspense
        fallback={
          <div className="p-6 mx-auto max-w-4xl">
            <div className="grid gap-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 w-full rounded-lg" />
              ))}
            </div>
          </div>
        }
      >
        <ProjectsList />
      </Suspense>
    </AuthGuard>
  );
}
