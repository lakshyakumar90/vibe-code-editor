"use client";

import Link from "next/link";
import { ArrowRight, FolderKanban, Star } from "lucide-react";

import {
  Button,
  Card,
  CardContent,
  Skeleton,
} from "@repo/ui";

import { useProjects } from "@/hooks/use-projects";
import { FavoriteButton } from "@/components/projects/favorite-button";
import { DeleteProjectButton } from "@/components/projects/delete-project-button";

interface StarredProjectsProps {
  /** Compact mode for the dashboard home (fewer rows, no header link). */
  compact?: boolean;
}

/**
 * Favorite projects section. Empty state renders nothing in compact mode
 * so the home page stays clean until the first star.
 */
export function StarredProjects({ compact = false }: StarredProjectsProps) {
  const { projects, loading, refetch, toggleFavorite } = useProjects();
  const starred = projects.filter((p) => p.isFavorite);

  if (loading) {
    return (
      <section className={compact ? "mt-10" : ""}>
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Starred projects</h2>
          <p className="text-sm text-muted-foreground">
            Your favorites, one click away.
          </p>
        </div>
        <div className="grid gap-4">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </section>
    );
  }

  if (starred.length === 0) {
    if (compact) return null;
    return (
      <div className="mx-auto w-full max-w-4xl p-6">
        <h1 className="mb-6 text-2xl font-bold">Starred projects</h1>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Star className="mb-4 size-12 text-muted-foreground" />
            <p className="mb-2 text-lg font-medium">No starred projects</p>
            <p className="mb-4 text-sm text-muted-foreground">
              Star a project to pin it here and in the sidebar.
            </p>
            <Button
              variant="outline"
              size="sm"
              render={<Link href="/dashboard/projects" />}
              nativeButton={false}
            >
              Browse projects
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const visible = compact ? starred.slice(0, 3) : starred;

  return (
    <section className={compact ? "mt-10" : ""}>
      <div className={compact ? "mb-4 flex items-center justify-between" : "mb-6 flex items-center justify-between"}>
        <div>
          <h2 className={compact ? "text-lg font-semibold" : "text-2xl font-bold"}>
            Starred projects
          </h2>
          {!compact && (
            <p className="text-sm text-muted-foreground">
              Your favorites, one click away.
            </p>
          )}
        </div>
        {compact && starred.length > 3 && (
          <Button variant="ghost" size="sm" render={<Link href="/dashboard/starred" />} nativeButton={false}>
            View all
          </Button>
        )}
      </div>

      <div className="grid gap-4">
        {visible.map((project) => (
          <div
            key={project.id}
            className="flex items-center gap-4 rounded-lg border p-4 transition-colors hover:bg-accent"
          >
            <Link
              href={`/dashboard/projects/${project.id}`}
              className="flex min-w-0 flex-1 items-center gap-4"
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/30">
                <FolderKanban className="size-5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{project.name}</p>
                <p className="truncate text-sm text-muted-foreground">
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
              <Button
                variant="ghost"
                size="icon"
                render={<Link href={`/dashboard/projects/${project.id}`} />}
                nativeButton={false}
              >
                <ArrowRight className="size-4" />
                <span className="sr-only">Open {project.name}</span>
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
