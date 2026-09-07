"use client";

import Link from "next/link";
import { ArrowLeft, Bot, Code2, Eye } from "lucide-react";
import { ModeToggle } from "@/components/layout/theme-mode-toggle";
import { useProject } from "@/hooks/use-projects";

export type EditorView = "code" | "preview";

interface EditorTopbarProps {
  projectId: string;
  view: EditorView;
  onViewChange: (view: EditorView) => void;
  agentOpen: boolean;
  onToggleAgent: () => void;
}

export function EditorTopbar({ projectId, view, onViewChange, agentOpen, onToggleAgent }: EditorTopbarProps) {
  const { project } = useProject(projectId);
  const tab = (active: boolean) =>
    `flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
      active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <header className="shrink-0 border-b bg-background">
      <div className="flex h-12 items-center justify-between px-3">
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
      </div>
      {/* View bar: agent toggle (left) + Code / Preview tabs + agent toggle (right) */}
      <div className="flex h-10 items-center gap-1 border-t bg-muted/30 px-3">
        <button
          onClick={onToggleAgent}
          className={tab(agentOpen)}
          title={agentOpen ? "Hide agent panel" : "Show agent panel"}
          aria-pressed={agentOpen}
        >
          <Bot className="size-3.5" />
          Agent
        </button>
        <span className="mx-1 h-5 w-px bg-border" />
        <button onClick={() => onViewChange("code")} className={tab(view === "code")} title="Code editor">
          <Code2 className="size-3.5" />
          Code
        </button>
        <button onClick={() => onViewChange("preview")} className={tab(view === "preview")} title="Preview">
          <Eye className="size-3.5" />
          Preview
        </button>
      </div>
    </header>
  );
}
