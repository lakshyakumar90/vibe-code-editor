"use client";

import { AuthGuard } from "@/components/auth/auth-guard";
import { EditorLayout } from "@/components/editor/editor-layout";
import { EditorTopbar } from "@/components/editor/editor-topbar";
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
        <div className="min-h-0 flex-1">
          <EditorLayout projectId={projectId} />
        </div>
      </div>
    </AuthGuard>
  );
}
