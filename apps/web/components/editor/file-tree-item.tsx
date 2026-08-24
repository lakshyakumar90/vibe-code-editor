"use client";

import { useState } from "react";
import type { FileTreeNode } from "@/lib/file-tree";
import type { ProjectFile } from "@/types/file";

interface FileTreeItemProps {
  node: FileTreeNode;
  selectedFileId: string | null;
  onSelectFile: (
    file: ProjectFile,
  ) => void;
}

export function FileTreeItem({
  node,
  selectedFileId,
  onSelectFile,
}: FileTreeItemProps) {
  const [expanded, setExpanded] =
    useState(true);

  if (node.isFolder) {
    return (
      <div>
        <button
          type="button"
          onClick={() =>
            setExpanded(
              (value) => !value,
            )
          }
          className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm"
        >
          <span>
            {expanded ? "▾" : "▸"}
          </span>

          <span>
            {node.name}
          </span>
        </button>

        {expanded && (
          <div className="ml-4">
            {node.children.map(
              (child) => (
                <FileTreeItem
                  key={child.id}
                  node={child}
                  selectedFileId={
                    selectedFileId
                  }
                  onSelectFile={
                    onSelectFile
                  }
                />
              ),
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() =>
        onSelectFile(node)
      }
      className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm ${
        selectedFileId === node.id
          ? "bg-accent"
          : ""
      }`}
    >
      <span>{node.name}</span>
    </button>
  );
}