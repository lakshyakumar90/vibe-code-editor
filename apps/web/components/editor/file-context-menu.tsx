"use client";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@repo/ui/components/ui/context-menu";
import {
  FilePlus2,
  FolderPlus,
  Scissors,
  Copy,
  ClipboardPaste,
  CopyPlus,
  Pencil,
  Trash2,
  Undo2,
  Redo2,
} from "lucide-react";
import type { ProjectFile } from "@/types/file";

type Action =
  | "newFile"
  | "newFolder"
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "rename"
  | "delete"
  | "undo"
  | "redo";

interface Props {
  file: ProjectFile;
  children: React.ReactNode;
  onAction: (action: Action, file: ProjectFile) => void;
  canPaste: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export function FileContextMenu({ file, children, onAction, canPaste, canUndo, canRedo }: Props) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => onAction("newFile", file)}>
          <FilePlus2 /> New File
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction("newFolder", file)}>
          <FolderPlus /> New Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onAction("cut", file)}>
          <Scissors /> Cut
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction("copy", file)}>
          <Copy /> Copy
        </ContextMenuItem>
        <ContextMenuItem disabled={!canPaste} onClick={() => onAction("paste", file)}>
          <ClipboardPaste /> Paste
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onAction("duplicate", file)}>
          <CopyPlus /> Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onAction("rename", file)}>
          <Pencil /> Rename
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => onAction("delete", file)}>
          <Trash2 /> Delete
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canUndo} onClick={() => onAction("undo", file)}>
          <Undo2 /> Undo
        </ContextMenuItem>
        <ContextMenuItem disabled={!canRedo} onClick={() => onAction("redo", file)}>
          <Redo2 /> Redo
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
