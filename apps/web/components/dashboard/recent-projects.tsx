import Link from "next/link";
import { ArrowRight, FolderKanban } from "lucide-react";

import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui";

const projects = [
  {
    id: "1",
    name: "Portfolio Website",
    description: "Personal portfolio and projects",
    owner: "You",
    members: [],
    template: "Next.js",
    lastOpened: "2 hours ago",
  },
  {
    id: "2",
    name: "SaaS Dashboard",
    description: "Admin dashboard",
    owner: "You",
    members: ["Aman", "Rahul"],
    template: "React",
    lastOpened: "Yesterday",
  },
  {
    id: "3",
    name: "Landing Page",
    description: "Marketing website",
    owner: "You",
    members: ["Priya"],
    template: "Next.js",
    lastOpened: "3 days ago",
  },
];

export function RecentProjects() {
  return (
    <section className="mt-10">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            Recent projects
          </h2>

          <p className="text-sm text-muted-foreground">
            Continue where you left off.
          </p>
        </div>

        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/projects">
            View all
          </Link>
        </Button>
      </div>

      {/* Table */}
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
                  <TableHead>Last opened</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>

              <TableBody>
                {projects.map((project) => (
                  <TableRow
                    key={project.id}
                    className="group"
                  >
                    {/* Project */}
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

                    {/* Owner */}
                    <TableCell>
                      <span className="text-sm">
                        {project.owner || "-"}
                      </span>
                    </TableCell>

                    {/* Members */}
                    <TableCell>
                      {project.members.length > 0 ? (
                        <div className="flex items-center gap-1">
                          {project.members
                            .slice(0, 2)
                            .map((member) => (
                              <span
                                key={member}
                                className="rounded-md bg-muted px-2 py-1 text-xs"
                              >
                                {member}
                              </span>
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

                    {/* Template */}
                    <TableCell>
                      <span className="rounded-md border bg-muted/30 px-2 py-1 text-xs font-medium">
                        {project.template}
                      </span>
                    </TableCell>

                    {/* Last opened */}
                    <TableCell>
                      <span className="whitespace-nowrap text-sm text-muted-foreground">
                        {project.lastOpened}
                      </span>
                    </TableCell>

                    {/* Action */}
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        asChild
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <Link
                          href={`/dashboard/projects/${project.id}`}
                        >
                          <ArrowRight className="size-4" />

                          <span className="sr-only">
                            Open {project.name}
                          </span>
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}