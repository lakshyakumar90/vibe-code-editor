"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderKanban, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { AuthGuard } from "@/components/auth/auth-guard";
import { Button, Card, CardContent, Skeleton } from "@repo/ui";

interface Project {
  id: string;
  name: string;
  description: string | null;
  template: string;
  createdAt: string;
  owner: {
    id: string;
    name: string;
    email: string;
  };
  members: {
    id: string;
    role: string;
  }[];
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ success: boolean; data: Project[] }>("/api/projects")
      .then((r) => setProjects(r.data))
      .finally(() => setLoading(false));
  }, []);

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
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/dashboard/projects/${p.id}`}
                className="flex items-center gap-4 border rounded-lg p-4 hover:bg-accent transition-colors"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/30">
                  <FolderKanban className="size-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{p.name}</p>
                  <p className="text-sm text-muted-foreground truncate">
                    {p.description || "No description"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="rounded-md border bg-muted/30 px-2 py-1 text-xs font-medium">
                    {p.template}
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {p.members.length} member{p.members.length !== 1 ? "s" : ""}
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
