"use client";

import { AuthGuard } from "@/components/auth/auth-guard";
import { EditorLayout } from "@/components/editor/editor-layout";
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
      <EditorLayout projectId={projectId} />
    </AuthGuard>
  );
}
