"use client";

import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { Button, Card, CardContent, Skeleton } from "@repo/ui";
import { useProjects } from "@/hooks/use-projects";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function ProjectsPage() {
  const { projects, loading } = useProjects();

  if (loading) {
    return (
      <AuthGuard>
        <div className="p-6 mx-auto max-w-4xl">
          <div className="flex justify-between mb-6">
            <h1 className="text-2xl font-bold">Your Projects</h1>
          </div>
          <div className="grid gap-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div className="p-6 mx-auto max-w-4xl">
        <div className="flex justify-between mb-6">
          <h1 className="text-2xl font-bold">Your Projects</h1>
        </div>

        {projects.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <FolderKanban className="size-12 text-muted-foreground mb-4" />
              <p className="text-lg font-medium mb-2">No projects yet</p>
              <p className="text-sm text-muted-foreground mb-4">
                Create your first project to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/dashboard/projects/${project.id}`}
                className="flex items-center gap-4 border rounded-lg p-4 hover:bg-accent transition-colors"
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
                <div className="flex items-center gap-3">
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
              </Link>
            ))}
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
