"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ModeToggle } from "@/components/layout/theme-mode-toggle";
import { useProject } from "@/hooks/use-projects";

interface EditorTopbarProps {
  projectId: string;
}

export function EditorTopbar({ projectId }: EditorTopbarProps) {
  const { project } = useProject(projectId);

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b bg-background px-3">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href="/dashboard/projects"
          aria-label="Back to projects"
          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <Link href="/" className="text-sm font-bold tracking-tight">
          Vibe
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="truncate text-sm text-muted-foreground">
          {project?.name ?? "Loading..."}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <ModeToggle />
      </div>
    </header>
  );
}
