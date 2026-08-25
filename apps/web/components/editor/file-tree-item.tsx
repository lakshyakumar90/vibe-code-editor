"use client";

import { useState } from "react";
import type { FileTreeNode } from "@/lib/file-tree";
import type { ProjectFile } from "@/types/file";
import { getFileIcon } from "@/lib/file-icons";
import { FileContextMenu } from "./file-context-menu";
import { InlineCreateRow } from "./inline-create-row";
import { ChevronRight, ChevronDown } from "lucide-react";

interface Props {
  node: FileTreeNode;
  selectedFileId: string | null;
  onSelectFile: (file: ProjectFile) => void;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onAction: (action: string, file: ProjectFile) => void;
  editingId: string | null;
  onRename: (file: ProjectFile, newName: string) => void;
  onEndEdit: () => void;
  clipboard: { op: "cut" | "copy"; file: ProjectFile } | null;
  canUndo: boolean;
  canRedo: boolean;
  pendingCreate: { parentId: string | null; isFolder: boolean; value: string } | null;
  onCreateChange: (v: string) => void;
  onCreateConfirm: () => void;
  onCreateCancel: () => void;
  depth: number;
}

export function FileTreeItem({
  node,
  selectedFileId,
  onSelectFile,
  expanded,
  onToggle,
  onAction,
  editingId,
  onRename,
  onEndEdit,
  clipboard,
  canUndo,
  canRedo,
  pendingCreate,
  onCreateChange,
  onCreateConfirm,
  onCreateCancel,
  depth,
}: Props) {
  const isExpanded = expanded.has(node.id);
  const isSelected = selectedFileId === node.id;
  const isEditing = editingId === node.id;
  const [draft, setDraft] = useState(node.name);
  const showInlineCreate = pendingCreate && pendingCreate.parentId === node.id && node.isFolder && isExpanded;

  if (node.isFolder) {
    return (
      <FileContextMenu file={node} onAction={onAction} canPaste={!!clipboard} canUndo={canUndo} canRedo={canRedo}>
        <div>
          <div
            onClick={() => onToggle(node.id)}
            onDoubleClick={() => onToggle(node.id)}
            className={`flex w-full items-center gap-1 px-1 py-1 text-left text-sm hover:bg-accent/50 cursor-pointer ${isSelected ? "bg-accent" : ""}`}
          >
            <span className="shrink-0">
              {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </span>
            {getFileIcon(node.name, true, isExpanded)}
            {isEditing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  onRename(node, draft);
                  onEndEdit();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onRename(node, draft);
                    onEndEdit();
                  }
                  if (e.key === "Escape") onEndEdit();
                }}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 bg-background border rounded px-1 py-0 text-sm"
              />
            ) : (
              <span className="truncate flex-1">{node.name}</span>
            )}
          </div>
          {isExpanded && (
            <div className="ml-3 border-l pl-1">
              {showInlineCreate && (
                <InlineCreateRow
                  isFolder={pendingCreate.isFolder}
                  value={pendingCreate.value}
                  onChange={onCreateChange}
                  onConfirm={onCreateConfirm}
                  onCancel={onCreateCancel}
                  depth={depth + 1}
                />
              )}
              {node.children.map((child) => (
                <FileTreeItem
                  key={child.id}
                  node={child}
                  selectedFileId={selectedFileId}
                  onSelectFile={onSelectFile}
                  expanded={expanded}
                  onToggle={onToggle}
                  onAction={onAction}
                  editingId={editingId}
                  onRename={onRename}
                  onEndEdit={onEndEdit}
                  clipboard={clipboard}
                  canUndo={canUndo}
                  canRedo={canRedo}
                  pendingCreate={pendingCreate}
                  onCreateChange={onCreateChange}
                  onCreateConfirm={onCreateConfirm}
                  onCreateCancel={onCreateCancel}
                  depth={depth + 1}
                />
              ))}
            </div>
          )}
        </div>
      </FileContextMenu>
    );
  }

  return (
    <FileContextMenu file={node} onAction={onAction} canPaste={!!clipboard} canUndo={canUndo} canRedo={canRedo}>
      <div
        onClick={() => onSelectFile(node)}
        className={`flex w-full items-center gap-1 px-1 py-1 text-left text-sm hover:bg-accent/50 cursor-pointer ml-1 ${isSelected ? "bg-accent" : ""} ${clipboard?.file.id === node.id ? "opacity-50" : ""}`}
      >
        <span className="w-3 shrink-0" />
        {getFileIcon(node.name, false, false)}
        {isEditing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              onRename(node, draft);
              onEndEdit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onRename(node, draft);
                onEndEdit();
              }
              if (e.key === "Escape") onEndEdit();
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 bg-background border rounded px-1 py-0 text-sm"
          />
        ) : (
          <span className="truncate flex-1">{node.name}</span>
        )}
      </div>
    </FileContextMenu>
  );
}
