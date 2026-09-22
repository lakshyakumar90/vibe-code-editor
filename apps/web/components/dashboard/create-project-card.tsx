"use client";

import {
  ArrowRight,
  Plus,
} from "lucide-react";

function GitHubIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.15c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.35.95.1-.74.4-1.25.72-1.53-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12v3.14c0 .3.2.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

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

      {/* GitHub import */}
      <Link href="/dashboard/import">
        <Card className="group h-full transition-colors hover:bg-accent/50">
          <CardHeader>
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border">
              <GitHubIcon />
            </div>

            <CardTitle>GitHub — Import an existing repository</CardTitle>

            <CardDescription>
              Bring a supported GitHub project into Vibe Code Editor.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <div className="flex items-center text-sm font-medium">
              Import from GitHub

              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
            </div>
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}