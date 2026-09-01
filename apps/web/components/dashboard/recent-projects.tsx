"use client";

import Link from "next/link";
import { ArrowRight, FolderKanban } from "lucide-react";

import {
  Button,
  Card,
  CardContent,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui";

import { useProjects } from "@/hooks/use-projects";

function formatRelativeTime(dateString: string): string {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function RecentProjects() {
  const { projects, loading } = useProjects({ limit: 5 });

  if (loading) {
    return (
      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Recent projects</h2>
            <p className="text-sm text-muted-foreground">
              Continue where you left off.
            </p>
          </div>
        </div>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="space-y-4 p-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Recent projects</h2>
          <p className="text-sm text-muted-foreground">
            Continue where you left off.
          </p>
        </div>

        <Button variant="ghost" size="sm" render={<Link href="/dashboard/projects" />}>
          View all
        </Button>
      </div>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>

              <TableBody>
                {projects.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">
                      <p className="text-muted-foreground">
                        No projects yet. Create your first project!
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  projects.map((project) => (
                    <TableRow key={project.id} className="group">
                      <TableCell>
                        <Link
                          href={`/dashboard/projects/${project.id}`}
                          className="flex min-w-[240px] items-center gap-3"
                        >
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30">
                            <FolderKanban className="size-4 text-muted-foreground" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium">
                              {project.name}
                            </p>
                            <p className="max-w-[280px] truncate text-sm text-muted-foreground">
                              {project.description || "-"}
                            </p>
                          </div>
                        </Link>
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium">
                            {getInitials(project.owner?.name || "You")}
                          </div>
                          <span className="text-sm">
                            {project.owner?.name || "You"}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell>
                        {project.members.length > 0 ? (
                          <div className="flex items-center gap-1">
                            {project.members.slice(0, 2).map((member) => (
                              <div
                                key={member.id}
                                className="flex items-center gap-1 rounded-md bg-muted px-2 py-1"
                              >
                                <div className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium">
                                  {getInitials(member.user?.name || "U")}
                                </div>
                                <span className="text-xs">
                                  {member.user?.name || "Unknown"}
                                </span>
                              </div>
                            ))}
                            {project.members.length > 2 && (
                              <span className="text-xs text-muted-foreground">
                                +{project.members.length - 2}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            -
                          </span>
                        )}
                      </TableCell>

                      <TableCell>
                        <span className="rounded-md border bg-muted/30 px-2 py-1 text-xs font-medium">
                          {project.template}
                        </span>
                      </TableCell>

                      <TableCell>
                        <span className="whitespace-nowrap text-sm text-muted-foreground">
                          {formatRelativeTime(project.createdAt)}
                        </span>
                      </TableCell>

                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          render={<Link href={`/dashboard/projects/${project.id}`} />}
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                        >
                          <ArrowRight className="size-4" />
                          <span className="sr-only">Open {project.name}</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
