"use client";

import { AuthGuard } from "@/components/auth/auth-guard";
import { EditorLayout } from "@/components/editor/editor-layout";
import { EditorTopbar } from "@/components/editor/editor-topbar";
import { PreviewPanel } from "@/components/editor/preview-panel";
import { RuntimeProvider } from "@/components/editor/runtime-provider";
import { useProject } from "@/hooks/use-projects";
import { parseTemplateId } from "@/lib/webcontainer/runtime";
import { use } from "react";

interface ProjectEditorPageProps {
  params: Promise<{
    projectId: string;
  }>;
}

export default function ProjectEditorPage({ params }: ProjectEditorPageProps) {
  const { projectId } = use(params);
  const { project, loading } = useProject(projectId);
  const template = parseTemplateId(project?.template);

  return (
    <AuthGuard>
      <div className="flex h-screen w-full flex-col overflow-hidden">
        <EditorTopbar projectId={projectId} />
        {loading && !project ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            Loading project…
          </div>
        ) : (
          <RuntimeProvider key={template} template={template}>
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div className="min-w-0 flex-1">
                <EditorLayout projectId={projectId} template={template} />
              </div>
              <PreviewPanel />
            </div>
          </RuntimeProvider>
        )}
      </div>
    </AuthGuard>
  );
}
