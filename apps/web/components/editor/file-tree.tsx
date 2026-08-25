"use client";

import { buildFileTree } from "@/lib/file-tree";
import type { ProjectFile } from "@/types/file";
import { FileTreeItem } from "./file-tree-item";
import { InlineCreateRow } from "./inline-create-row";
import { ContextMenu } from "@repo/ui/components/ui/context-menu";
import { ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@repo/ui/components/ui/context-menu";
import { FilePlus2, FolderPlus, Undo2, Redo2 } from "lucide-react";

interface FileTreeProps {
  projectId: string;
  files: ProjectFile[];
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
}

export function FileTree({
  files,
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
}: FileTreeProps) {
  const tree = buildFileTree(files);
  const isRootPending = pendingCreate && pendingCreate.parentId === null;

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div className="flex h-full flex-col overflow-hidden text-sm select-none">
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-1">
            {isRootPending && (
              <InlineCreateRow
                isFolder={pendingCreate.isFolder}
                value={pendingCreate.value}
                onChange={onCreateChange}
                onConfirm={onCreateConfirm}
                onCancel={onCreateCancel}
                depth={0}
              />
            )}
          {tree.length === 0 && !isRootPending ? (
            <div className="p-3 text-xs text-muted-foreground">No files - right click to create</div>
          ) : (
            tree.map((node) => (
              <FileTreeItem
                key={node.id}
                node={node}
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
                depth={0}
              />
            ))
          )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem
          onClick={() => {
            // create at root via synthetic file
            const synthetic = { id: "root", name: "root", isFolder: true, parentId: null } as ProjectFile;
            onAction("newFile", synthetic);
          }}
        >
          <FilePlus2 /> New File
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            const synthetic = { id: "root", name: "root", isFolder: true, parentId: null } as ProjectFile;
            (synthetic as unknown as { _root: boolean })._root = true;
            onAction("newFolder", { ...synthetic, id: "__root__" } as ProjectFile);
          }}
        >
          <FolderPlus /> New Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canUndo} onClick={() => onAction("undo", {} as ProjectFile)}>
          <Undo2 /> Undo
        </ContextMenuItem>
        <ContextMenuItem disabled={!canRedo} onClick={() => onAction("redo", {} as ProjectFile)}>
          <Redo2 /> Redo
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
