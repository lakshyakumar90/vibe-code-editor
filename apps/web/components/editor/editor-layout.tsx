"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import type { ProjectFile } from "@/types/file";
import { FileTree } from "./file-tree";
import { CodeEditor } from "./code-editor";
import { api } from "@/lib/api";
import { getUniqueName, getPasteParentId, collectDescendants } from "@/lib/file-utils";
import { getFileIcon } from "@/lib/file-icons";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@repo/ui/components/ui/alert-dialog";
import { X, Circle } from "lucide-react";

interface EditorLayoutProps {
  projectId: string;
}

interface FilesResponse {
  success: boolean;
  data: ProjectFile[];
}

export function EditorLayout({ projectId }: EditorLayoutProps) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [openFiles, setOpenFiles] = useState<ProjectFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [editedContents, setEditedContents] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<{ op: "cut" | "copy"; file: ProjectFile } | null>(null);
  const [history, setHistory] = useState<ProjectFile[][]>([]);
  const [future, setFuture] = useState<ProjectFile[][]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{ parentId: string | null; isFolder: boolean; value: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectFile | null>(null);
  const [closeTarget, setCloseTarget] = useState<ProjectFile | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  const activeFile = activeFileId ? openFiles.find((f) => f.id === activeFileId) ?? files.find((f) => f.id === activeFileId) ?? null : null;
  const activeValue = activeFile ? (editedContents[activeFile.id] ?? activeFile.content ?? "") : "";
  const isActiveDirty = activeFile ? activeValue !== (activeFile.content ?? "") : false;

  const pushHistory = useCallback((prev: ProjectFile[]) => {
    setHistory((h) => [...h, prev]);
    setFuture([]);
  }, []);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    try {
      if (!silent) setLoading(true);
      const response = await api.get<ProjectFile[] | FilesResponse>(`/api/projects/${projectId}/files`);
      const arr: ProjectFile[] = Array.isArray(response) ? response : ((response as FilesResponse).data ?? []);
      setFiles(arr);
      // sync openFiles metadata (path/name) but keep editedContents
      setOpenFiles((prev) => prev.map((of) => arr.find((f) => f.id === of.id) ?? of).filter((of) => arr.some((f) => f.id === of.id)));
      // if active file was deleted, clear
      if (activeFileId && !arr.find((f) => f.id === activeFileId)) {
        setActiveFileId(null);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load files");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [projectId, activeFileId]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleOpenFile = useCallback((file: ProjectFile) => {
    if (file.isFolder) {
      toggle(file.id);
      return;
    }
    setOpenFiles((prev) => (prev.some((f) => f.id === file.id) ? prev : [...prev, file]));
    setActiveFileId(file.id);
  }, [toggle]);

  const handleTabClick = useCallback((fileId: string) => {
    setActiveFileId(fileId);
  }, []);

  const handleContentChange = useCallback((fileId: string, newValue: string) => {
    setEditedContents((prev) => ({ ...prev, [fileId]: newValue }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    const currentValue = editedContents[activeFile.id];
    if (currentValue === undefined || currentValue === (activeFile.content ?? "")) {
      toast.info("No changes to save");
      return;
    }
    try {
      setSaving(true);
      await api.put(`/api/projects/${projectId}/files/${activeFile.id}`, {
        content: currentValue,
      });
      const updated = { ...activeFile, content: currentValue } as ProjectFile;
      setFiles((prev) => prev.map((f) => (f.id === activeFile.id ? updated : f)));
      setOpenFiles((prev) => prev.map((f) => (f.id === activeFile.id ? updated : f)));
      setEditedContents((prev) => {
        const next = { ...prev };
        delete next[activeFile.id];
        return next;
      });
      toast.success("Saved");
      setTimeout(() => refresh({ silent: true }), 0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [activeFile, editedContents, projectId, refresh]);

  const requestClose = useCallback((file: ProjectFile) => {
    const dirty = editedContents[file.id] !== undefined && editedContents[file.id] !== (file.content ?? "");
    if (dirty) setCloseTarget(file);
    else {
      setOpenFiles((prev) => prev.filter((f) => f.id !== file.id));
      setEditedContents((prev) => {
        const next = { ...prev };
        delete next[file.id];
        return next;
      });
      if (activeFileId === file.id) {
        const remaining = openFiles.filter((f) => f.id !== file.id);
        setActiveFileId(remaining.length ? remaining.at(-1)?.id ?? null : null);
      }
    }
  }, [editedContents, openFiles, activeFileId]);

  const confirmClose = useCallback(async (shouldSave: boolean) => {
    if (!closeTarget) return;
    if (shouldSave) {
      const val = editedContents[closeTarget.id];
      if (val !== undefined && val !== (closeTarget.content ?? "")) {
        try {
          setSaving(true);
          await api.put(`/api/projects/${projectId}/files/${closeTarget.id}`, { content: val });
          const updated = { ...closeTarget, content: val } as ProjectFile;
          setFiles((prev) => prev.map((f) => (f.id === closeTarget.id ? updated : f)));
          setOpenFiles((prev) => prev.map((f) => (f.id === closeTarget.id ? updated : f)));
          toast.success("Saved");
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Failed to save");
          return;
        } finally {
          setSaving(false);
        }
      }
    }
    const id = closeTarget.id;
    setOpenFiles((prev) => prev.filter((f) => f.id !== id));
    setEditedContents((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (activeFileId === id) {
      const remaining = openFiles.filter((f) => f.id !== id);
      setActiveFileId(remaining.length ? remaining.at(-1)?.id ?? null : null);
    }
    setCloseTarget(null);
  }, [closeTarget, editedContents, projectId, openFiles, activeFileId]);

  const handleCreate = useCallback(async (parentId: string | null, isFolder: boolean, name: string) => {
    const unique = getUniqueName(name, parentId, filesRef.current);
    pushHistory([...filesRef.current]);
    try {
      const created = await api.post<ProjectFile>(`/api/projects/${projectId}/files`, {
        name: unique, parentId, isFolder, content: isFolder ? null : "",
      });
      const file: ProjectFile = (created as unknown as ProjectFile) ?? (created as unknown as { data: ProjectFile }).data ?? (created as unknown as ProjectFile);
      await refresh({ silent: true });
      if (parentId) setExpanded((s) => new Set(s).add(parentId));
      if (file?.id && !isFolder) handleOpenFile(file);
      toast.success(`${isFolder ? "Folder" : "File"} created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create");
    }
  }, [projectId, pushHistory, refresh, handleOpenFile]);

  const handleRename = useCallback(async (file: ProjectFile, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === file.name) return;
    const unique = getUniqueName(trimmed, file.parentId, filesRef.current.filter((f) => f.id !== file.id));
    pushHistory([...filesRef.current]);
    setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, name: unique } : f)));
    setOpenFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, name: unique } : f)));
    try {
      await api.put(`/api/projects/${projectId}/files/${file.id}`, { name: unique });
      await refresh({ silent: true });
      toast.success("Renamed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rename failed");
      await refresh({ silent: true });
    }
  }, [projectId, pushHistory, refresh]);

  const handleDelete = useCallback(async (file: ProjectFile) => {
    pushHistory([...filesRef.current]);
    const toRemove = new Set(collectDescendants(filesRef.current, file.id));
    setFiles((prev) => prev.filter((f) => !toRemove.has(f.id)));
    setOpenFiles((prev) => prev.filter((f) => !toRemove.has(f.id)));
    // clear edited contents for removed files
    setEditedContents((prev) => {
      const next = { ...prev };
      toRemove.forEach((id) => delete next[id]);
      return next;
    });
    if (activeFileId && toRemove.has(activeFileId)) {
      const remaining = openFiles.filter((f) => !toRemove.has(f.id));
      setActiveFileId(remaining.length ? remaining.at(-1)?.id ?? null : null);
    }
    try {
      await api.delete(`/api/projects/${projectId}/files/${file.id}`);
      await refresh({ silent: true });
      toast.success("Deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
      await refresh({ silent: true });
    }
  }, [projectId, pushHistory, refresh, activeFileId, openFiles]);

  const handleDuplicate = useCallback(async (file: ProjectFile) => {
    const parentId = file.parentId;
    const unique = getUniqueName(file.name, parentId, filesRef.current);
    pushHistory([...filesRef.current]);
    try {
      if (file.isFolder) {
        const created = await api.post<ProjectFile>(`/api/projects/${projectId}/files`, { name: unique, parentId, isFolder: true });
        const newFolder = (created as unknown as ProjectFile) ?? (created as unknown as { data: ProjectFile }).data;
        const children = filesRef.current.filter((f) => f.parentId === file.id);
        for (const child of children) {
          const childName = getUniqueName(child.name, newFolder?.id ?? null, filesRef.current);
          await api.post(`/api/projects/${projectId}/files`, { name: childName, parentId: newFolder?.id ?? null, isFolder: child.isFolder, content: child.content });
        }
      } else {
        await api.post(`/api/projects/${projectId}/files`, { name: unique, parentId, isFolder: false, content: file.content });
      }
      await refresh({ silent: true });
      toast.success("Duplicated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Duplicate failed");
    }
  }, [projectId, pushHistory, refresh]);

  const handlePaste = useCallback(async (target: ProjectFile) => {
    if (!clipboard) return;
    const pasteParentId = getPasteParentId(target, filesRef.current);
    const src = clipboard.file;
    if (src.isFolder && pasteParentId) {
      const isDesc = src.id === pasteParentId || isDescendant(filesRef.current, src.id, pasteParentId);
      if (isDesc) { toast.error("Cannot paste folder into itself"); return; }
    }
    pushHistory([...filesRef.current]);
    try {
      if (clipboard.op === "cut") {
        const unique = getUniqueName(src.name, pasteParentId, filesRef.current.filter((f) => f.id !== src.id));
        await api.put(`/api/projects/${projectId}/files/${src.id}/move`, { parentId: pasteParentId, name: unique });
        setClipboard(null);
      } else {
        const unique = getUniqueName(src.name, pasteParentId, filesRef.current);
        await api.post(`/api/projects/${projectId}/files`, { name: unique, parentId: pasteParentId, isFolder: src.isFolder, content: src.content });
      }
      await refresh({ silent: true });
      if (pasteParentId) setExpanded((s) => new Set(s).add(pasteParentId));
      toast.success("Pasted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Paste failed");
    }
  }, [clipboard, projectId, pushHistory, refresh]);

  const handleAction = useCallback((action: string, file: ProjectFile) => {
    const resolveParent = (f: ProjectFile) => {
      if ((f as unknown as { id: string }).id === "__root__" || (f as unknown as { id: string }).id === "root") return null;
      return f.isFolder ? f.id : f.parentId;
    };
    switch (action) {
      case "newFile": {
        const parentId = resolveParent(file);
        setPendingCreate({ parentId, isFolder: false, value: "" });
        if (parentId) setExpanded((s) => new Set(s).add(parentId));
        break;
      }
      case "newFolder": {
        const parentId = resolveParent(file);
        setPendingCreate({ parentId, isFolder: true, value: "" });
        if (parentId) setExpanded((s) => new Set(s).add(parentId));
        break;
      }
      case "cut": setClipboard({ op: "cut", file }); toast.info("Cut - select paste target"); break;
      case "copy": setClipboard({ op: "copy", file }); toast.info("Copied - select paste target"); break;
      case "paste": handlePaste(file); break;
      case "duplicate": handleDuplicate(file); break;
      case "rename": setEditingId(file.id); break;
      case "delete": setDeleteTarget(file); break;
      case "undo": {
        setHistory((h) => {
          if (h.length === 0) { toast.info("Nothing to undo"); return h; }
          const prev = h[h.length - 1]!;
          setFuture((f) => [...f, [...filesRef.current]]);
          setFiles(prev!);
          toast.success("Undone (local)");
          return h.slice(0, -1);
        });
        break;
      }
      case "redo": {
        setFuture((f) => {
          if (f.length === 0) { toast.info("Nothing to redo"); return f; }
          const next = f[f.length - 1]!;
          setHistory((h) => [...h, [...filesRef.current]]);
          setFiles(next!);
          toast.success("Redone (local)");
          return f.slice(0, -1);
        });
        break;
      }
    }
  }, [handleDelete, handleDuplicate, handlePaste]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        handleAction("undo", filesRef.current[0] as ProjectFile);
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        handleAction("redo", filesRef.current[0] as ProjectFile);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleAction]);

  function isDescendant(all: ProjectFile[], ancestorId: string, fileId: string): boolean {
    let cur = all.find((f) => f.id === fileId);
    while (cur?.parentId) {
      if (cur.parentId === ancestorId) return true;
      cur = all.find((f) => f.id === cur!.parentId);
    }
    return false;
  }

  const confirmCreate = async () => {
    if (!pendingCreate || !pendingCreate.value.trim()) return;
    const { parentId, isFolder, value } = pendingCreate;
    setPendingCreate(null);
    await handleCreate(parentId, isFolder, value.trim());
  };
  const cancelCreate = () => setPendingCreate(null);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <aside className="w-72 shrink-0 border-r flex flex-col overflow-hidden bg-card">
        <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Explorer</span>
          <span className="text-[11px]">{clipboard ? `${clipboard.op}: ${clipboard.file.name}` : ""}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {loading ? <div className="p-4 text-sm">Loading files...</div> : (
            <FileTree
              projectId={projectId}
              files={files}
              selectedFileId={activeFileId}
              onSelectFile={handleOpenFile}
              expanded={expanded}
              onToggle={toggle}
              onAction={handleAction}
              editingId={editingId}
              onRename={handleRename}
              onEndEdit={() => setEditingId(null)}
              clipboard={clipboard}
              canUndo={history.length > 0}
              canRedo={future.length > 0}
              pendingCreate={pendingCreate}
              onCreateChange={(v) => setPendingCreate((p) => (p ? { ...p, value: v } : p))}
              onCreateConfirm={confirmCreate}
              onCreateCancel={cancelCreate}
            />
          )}
        </div>
      </aside>

      <main className="min-w-0 flex flex-1 flex-col overflow-hidden bg-background">
        {/* VS Code style tabs - light */}
        {openFiles.length > 0 && (
          <div className="flex h-9 shrink-0 items-center overflow-x-auto border-b bg-muted/40 scrollbar-thin">
            {openFiles.map((of) => {
              const isActive = of.id === activeFileId;
              const isDirty = editedContents[of.id] !== undefined && editedContents[of.id] !== (of.content ?? "");
              return (
                <div
                  key={of.id}
                  onClick={() => handleTabClick(of.id)}
                  className={`flex h-full shrink-0 items-center gap-2 border-r px-3 text-sm cursor-pointer ${isActive ? "bg-background text-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                >
                  {getFileIcon(of.name, false, false)}
                  <span className="truncate max-w-[120px]">{of.name}</span>
                  {isDirty ? <Circle className="size-2 fill-primary text-primary shrink-0" /> : <span className="size-2 shrink-0" />}
                  <button
                    onClick={(e) => { e.stopPropagation(); requestClose(of); }}
                    className="ml-1 rounded p-0.5 hover:bg-accent"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {activeFile && (
          <div className="flex h-8 shrink-0 items-center justify-end gap-3 border-b bg-background px-4 text-xs">
            <span className={saving ? "text-muted-foreground" : isActiveDirty ? "text-yellow-600" : "text-muted-foreground"}>
              {saving ? "Saving..." : isActiveDirty ? "● Unsaved" : "Saved"}
            </span>
            <button
              onClick={handleSave}
              disabled={!isActiveDirty || saving}
              className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Save (Ctrl+S)
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {activeFile ? (
            <CodeEditor
              projectId={projectId}
              file={activeFile}
              value={activeValue}
              onChange={(v) => handleContentChange(activeFile.id, v)}
              onSave={handleSave}
              saving={saving}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file to begin editing.</div>
          )}
        </div>
      </main>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.isFolder ? "folder" : "file"}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.isFolder ? `This will permanently delete "${deleteTarget?.name}" and all its contents.` : `This will permanently delete "${deleteTarget?.name}".`} This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (deleteTarget) handleDelete(deleteTarget); setDeleteTarget(null); }}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!closeTarget} onOpenChange={(o) => !o && setCloseTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>Do you want to save changes to {closeTarget?.name}? Your changes will be lost if you don&apos;t save them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setCloseTarget(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="outline" onClick={() => confirmClose(false)}>Don&apos;t Save</AlertDialogAction>
            <AlertDialogAction onClick={() => confirmClose(true)}>Save</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
