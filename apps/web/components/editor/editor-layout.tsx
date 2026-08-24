"use client";

import { useState } from "react";
import type { ProjectFile } from "@/types/file";
import { FileTree } from "./file-tree";
import { CodeEditor } from "./code-editor";

interface EditorLayoutProps {
  projectId: string;
}

export function EditorLayout({
  projectId,
}: EditorLayoutProps) {
  const [selectedFile, setSelectedFile] =
    useState<ProjectFile | null>(
      null,
    );

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-64 shrink-0 border-r">
        <FileTree
          projectId={projectId}
          selectedFileId={
            selectedFile?.id ?? null
          }
          onSelectFile={
            setSelectedFile
          }
        />
      </aside>

      <main className="min-w-0 flex-1">
        <CodeEditor
          projectId={projectId}
          file={selectedFile}
        />
      </main>
    </div>
  );
}