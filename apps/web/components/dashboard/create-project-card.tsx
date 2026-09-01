"use client";

import {
  ArrowRight,
  X,
  Plus,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui";
import Link from "next/link";

interface CreateProjectCardProps {
  onCreateProject: () => void;
}

export function CreateProjectCard({
  onCreateProject,
}: CreateProjectCardProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Create project */}
      <button
        type="button"
        onClick={onCreateProject}
        className="group block w-full text-left"
      >
        <Card className="h-full transition-colors group-hover:bg-accent/50">
          <CardHeader>
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Plus className="h-5 w-5" />
            </div>

            <CardTitle>Create a project</CardTitle>

            <CardDescription>
              Start building something new from scratch.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <div className="flex items-center text-sm font-medium">
              Get started

              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
            </div>
          </CardContent>
        </Card>
      </button>

      {/* X import */}
      <Link href="/dashboard/import">
        <Card className="group h-full transition-colors hover:bg-accent/50">
          <CardHeader>
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border">
              <X className="h-5 w-5" />
            </div>

            <CardTitle>Import from GitHub</CardTitle>

            <CardDescription>
              Import an existing repository and continue building.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <div className="flex items-center text-sm font-medium">
              Import repository

              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
            </div>
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}