"use client";

import { AuthGuard } from "@/components/auth/auth-guard";
import { EditorLayout } from "@/components/editor/editor-layout";
import { EditorTopbar, type EditorView } from "@/components/editor/editor-topbar";
import { RuntimeProvider } from "@/components/editor/runtime-provider";
import { useProject } from "@/hooks/use-projects";
import { parseTemplateId } from "@/lib/webcontainer/runtime";
import { use, useState } from "react";

interface ProjectEditorPageProps {
  params: Promise<{
    projectId: string;
  }>;
}

export default function ProjectEditorPage({ params }: ProjectEditorPageProps) {
  const { projectId } = use(params);
  const { project, loading } = useProject(projectId);
  const template = parseTemplateId(project?.template);
  const [view, setView] = useState<EditorView>("code");
  const [agentOpen, setAgentOpen] = useState(true);

  return (
    <AuthGuard>
      <div className="flex h-screen w-full flex-col overflow-hidden">
        <EditorTopbar
          projectId={projectId}
          view={view}
          onViewChange={setView}
          agentOpen={agentOpen}
          onToggleAgent={() => setAgentOpen((v) => !v)}
        />
        {loading && !project ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            Loading project…
          </div>
        ) : (
          <RuntimeProvider key={template} template={template}>
            {/* Single EditorLayout instance so the agent chat + terminals
                survive Code/Preview switches. Preview takes full width
                (no file tree, no bottom panel) when active. */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <EditorLayout
                projectId={projectId}
                template={template}
                agentOpen={agentOpen}
                onAgentChange={setAgentOpen}
                view={view}
              />
            </div>
          </RuntimeProvider>
        )}
      </div>
    </AuthGuard>
  );
}
