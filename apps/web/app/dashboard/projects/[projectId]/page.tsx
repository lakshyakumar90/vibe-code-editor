"use client";

import { AuthGuard } from "@/components/auth/auth-guard";
import { EditorLayout } from "@/components/editor/editor-layout";
import { EditorTopbar } from "@/components/editor/editor-topbar";
import { PreviewPanel } from "@/components/editor/preview-panel";
import { RuntimeProvider } from "@/components/editor/runtime-provider";
import { use } from "react";

interface ProjectEditorPageProps {
  params: Promise<{
    projectId: string;
  }>;
}

export default function ProjectEditorPage({ params }: ProjectEditorPageProps) {
  const { projectId } = use(params);

  return (
    <AuthGuard>
      <div className="flex h-screen w-full flex-col overflow-hidden">
        <EditorTopbar projectId={projectId} />
        <RuntimeProvider>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="min-w-0 flex-1">
              <EditorLayout projectId={projectId} />
            </div>
            <PreviewPanel />
          </div>
        </RuntimeProvider>
      </div>
    </AuthGuard>
  );
}
