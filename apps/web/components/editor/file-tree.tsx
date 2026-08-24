"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { buildFileTree } from "@/lib/file-tree";
import type { ProjectFile } from "@/types/file";
import { FileTreeItem } from "./file-tree-item";

interface FileTreeProps {
  projectId: string;
  selectedFileId: string | null;
  onSelectFile: (file: ProjectFile) => void;
}

interface FilesResponse {
  success: boolean;
  data: ProjectFile[];
}

export function FileTree({
  projectId,
  selectedFileId,
  onSelectFile,
}: FileTreeProps) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadFiles() {
      try {
        setLoading(true);

        const response = await api.get<ProjectFile[] | FilesResponse>(`/api/projects/${projectId}/files`);
        if (!cancelled) {
          // handles both raw [] and {success,data:[]} if you later normalize server
          const arr = Array.isArray(response) ? response : (response as FilesResponse).data ?? [];
          setFiles(arr);
        }

      } catch (error) {
        if (!cancelled) {
          setError(
            error instanceof Error ? error.message : "Failed to load files",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadFiles();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return <div className="p-4 text-sm">Loading files...</div>;
  }

  if (error) {
    return <div className="p-4 text-sm text-red-500">{error}</div>;
  }

  const tree = buildFileTree(files);

  return (
    <div className="h-full overflow-y-auto p-2">
      {tree.map((node) => (
        <FileTreeItem
          key={node.id}
          node={node}
          selectedFileId={selectedFileId}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}
