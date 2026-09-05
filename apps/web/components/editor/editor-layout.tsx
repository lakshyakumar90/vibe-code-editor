"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import type { ProjectFile } from "@/types/file";
import { FileTree } from "./file-tree";
import { CodeEditor } from "./code-editor";
import { api } from "@/lib/api";
import { getUniqueName, getPasteParentId, collectDescendants } from "@/lib/file-utils";
import { getFileIcon, getLanguage } from "@/lib/file-icons";
import { createWorkspace, type VirtualWorkspace } from "@/lib/workspace/workspace";
import { buildPathToId } from "@/lib/workspace/file-map";
import { hashPackageJson } from "@/lib/webcontainer/dependency-state";
import { removeModelByPath } from "@/lib/language/model-manager";
import { ensureModel, getSharedMonaco, requestLanguageSetup } from "@/lib/language/model-manager";
import { loadProjectTsconfig } from "@/lib/language/tsconfig-loader";
import { ensureDependencyTypes } from "@/lib/language/dependency-loader";
import { setActiveTemplate } from "@/lib/language/dependency-loader";
import { revealInEditor } from "@/lib/language/model-manager";
import { ProblemsPanel } from "./problems-panel";
import type { Problem } from "@/lib/language/diagnostics";
import { useRuntime } from "./runtime-provider";
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
  /** Project template — drives runtime commands + TS config. */
  template?: string;
}

interface FilesResponse {
  success: boolean;
  data: ProjectFile[];
}

/** "src/a/b.ts" -> "src/a" (null at root). Mirrors server buildFilePath. */
function dirOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i === -1 ? null : path.slice(0, i);
}

/** Path a child would get under parentId (root when parentId is null). */
function childPath(
  files: ProjectFile[],
  parentId: string | null,
  name: string,
): string {
  if (!parentId) return name;
  const parent = files.find((f) => f.id === parentId);
  return parent ? `${parent.path}/${name}` : name;
}

/** Non-folder files at dir or under it. */
function filesUnder(files: ProjectFile[], dir: string): ProjectFile[] {
  return files.filter(
    (f) => !f.isFolder && (f.path === dir || f.path.startsWith(`${dir}/`)),
  );
}

export function EditorLayout({ projectId, template = "REACT" }: EditorLayoutProps) {
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
  const [sidebarWidth, setSidebarWidth] = useState(288);
  const [isResizing, setIsResizing] = useState(false);
  const [showProblems, setShowProblems] = useState(true);
  const [problemCounts, setProblemCounts] = useState({ errors: 0, warnings: 0 });
  const [problemsHeight, setProblemsHeight] = useState(176);
  const [isResizingProblems, setIsResizingProblems] = useState(false);
  const filesRef = useRef(files);
  filesRef.current = files;
  const editedContentsRef = useRef(editedContents);
  editedContentsRef.current = editedContents;

  // --- WebContainer / workspace sync (Steps 0+1+6) ---
  const { runtime, bootAndMount, install, start, status: runtimeStatus } = useRuntime();
  const workspaceRef = useRef<VirtualWorkspace | null>(null);
  const pathToIdRef = useRef<Map<string, string>>(new Map());
  const bootedRef = useRef(false);
  const startedRef = useRef(false);
  const containerReadyRef = useRef(false);
  const depHashRef = useRef<string>("");
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, []);

  /** Best-effort mirror into the container FS + workspace. Never throws. */
  const containerWrite = useCallback(
    async (path: string, content: string) => {
      workspaceRef.current?.updateFile(path, content);
      if (!containerReadyRef.current) return;
      try {
        await runtime.writeFile(path, content);
      } catch {
        toast.error("Sync to runtime failed");
      }
    },
    [runtime],
  );

  /**
   * Keep the language graph complete on structural ops: materialize a
   * model for newly created paths (no-op when the editor never mounted).
   */
  const ensureFileModel = useCallback(
    (path: string, content: string, name: string) => {
      const monaco = getSharedMonaco();
      if (!monaco) return;
      try {
        ensureModel(monaco, path, content, getLanguage(name));
      } catch {
        // Best effort — opening the file later self-heals.
      }
    },
    [],
  );

  const containerRemove = useCallback(
    async (path: string) => {
      workspaceRef.current?.deleteFile(path);
      removeModelByPath(path);
      if (!containerReadyRef.current) return;
      try {
        await runtime.rm(path, true);
      } catch {
        toast.error("Sync to runtime failed");
      }
    },
    [runtime],
  );

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
      return arr;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load files");
      return [] as ProjectFile[];
    } finally {
      if (!silent) setLoading(false);
    }
  }, [projectId, activeFileId]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Boot the runtime once files arrive: workspace -> language setup
  // (project tsconfig + full model preload) -> mount -> install -> dev.
  // Structural edits later only mirror (no reinstall/remount).
  // Re-runs after a provider reset() (status back to idle) for manual retry.
  useEffect(() => {
    if (files.length === 0 || bootedRef.current) return;
    if (runtimeStatus !== "idle") return;
    bootedRef.current = true;
    const snapshot = [...files];
    workspaceRef.current = createWorkspace(snapshot);
    pathToIdRef.current = buildPathToId(snapshot);
    setActiveTemplate(template);
    // Phase 1 + Phase 2: project tsconfig becomes the worker config and
    // every source file becomes a model — deferred until Monaco mounts.
    // Supplier re-reads live state so content is never stale.
    const tsconfig = loadProjectTsconfig(workspaceRef.current);
    requestLanguageSetup(tsconfig.compilerOptions, template, () =>
      filesRef.current
        .filter((f) => !f.isFolder)
        .map((f) => ({
          path: f.path,
          content:
            editedContentsRef.current[f.id] ?? f.content ?? "",
          language: getLanguage(f.name),
        })),
    );
    void (async () => {
      try {
        await bootAndMount(snapshot.map((f) => ({ path: f.path, content: f.content, isFolder: f.isFolder })));
        containerReadyRef.current = true;
        await install();
        const packageJson =
          workspaceRef.current?.getFile("package.json") ?? "";
        depHashRef.current = hashPackageJson(packageJson);
        // Types need both install output (node_modules) and a mounted
        // Monaco instance; the loader defers itself if editor isn't up yet.
        void ensureDependencyTypes(runtime, packageJson);
        await start();
        startedRef.current = true;
      } catch {
        // status/error surface in PreviewPanel via the provider
        bootedRef.current = false;
        containerReadyRef.current = false;
      }
    })();
  }, [files, bootAndMount, install, start, runtime, template, runtimeStatus]);

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

  const handleSelectProblem = useCallback((problem: Problem) => {
    const target = filesRef.current.find(
      (f) => !f.isFolder && f.path === problem.dbPath,
    );
    if (!target) {
      toast.error(`File not found: ${problem.dbPath}`);
      return;
    }
    setOpenFiles((prev) =>
      prev.some((f) => f.id === target.id) ? prev : [...prev, target],
    );
    setActiveFileId(target.id);
    // Let the editor swap to the file's model, then jump to the marker.
    const { line, column, dbPath } = problem;
    setTimeout(() => revealInEditor(dbPath, line, column), 100);
    setTimeout(() => revealInEditor(dbPath, line, column), 400);
  }, []);

  const handleContentChange = useCallback((fileId: string, newValue: string) => {
    setEditedContents((prev) => ({ ...prev, [fileId]: newValue }));
    // Immediate: workspace (TS worker reads the Monaco model directly).
    // Debounced ~400ms: container FS -> Vite HMR. DB persist stays manual (Save).
    const target = filesRef.current.find((f) => f.id === fileId);
    if (target && !target.isFolder) {
      workspaceRef.current?.updateFile(target.path, newValue);
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
      const path = target.path;
      writeTimerRef.current = setTimeout(() => {
        if (!containerReadyRef.current) return;
        runtime.writeFile(path, newValue).catch(() => {
          toast.error("Sync to runtime failed");
        });
      }, 400);
    }
  }, [runtime]);

  /** Reinstall + restart when package.json content actually changed. */
  const maybeReinstall = useCallback(async (file: ProjectFile, content: string) => {
    if (file.name !== "package.json" || !startedRef.current) return;
    const newHash = hashPackageJson(content);
    if (depHashRef.current && newHash !== depHashRef.current) {
      depHashRef.current = newHash;
      toast.info("Dependencies changed — reinstalling…");
      try {
        await install();
        await runtime.restartDevServer();
        void ensureDependencyTypes(runtime, content);
        toast.success("Dependencies updated");
      } catch {
        toast.error("Reinstall failed");
      }
    } else {
      depHashRef.current = newHash;
    }
  }, [install, runtime]);

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
      // Ensure the container has the saved content (covers edits made
      // before boot finished), then handle dependency changes.
      void containerWrite(activeFile.path, currentValue);
      await maybeReinstall(activeFile, currentValue);
      setTimeout(() => refresh({ silent: true }), 0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [activeFile, editedContents, projectId, refresh, containerWrite, maybeReinstall]);

  /** Persist every dirty open file (PUT per file, one refresh at the end). */
  const handleSaveAll = useCallback(async () => {
    const entries = Object.entries(editedContentsRef.current);
    if (entries.length === 0) {
      toast.info("No changes to save");
      return;
    }
    try {
      setSaving(true);
      let saved = 0;
      for (const [fileId, content] of entries) {
        const file = filesRef.current.find((f) => f.id === fileId);
        if (!file || file.isFolder || content === (file.content ?? "")) continue;
        await api.put(`/api/projects/${projectId}/files/${fileId}`, { content });
        const updated = { ...file, content } as ProjectFile;
        setFiles((prev) => prev.map((f) => (f.id === fileId ? updated : f)));
        setOpenFiles((prev) => prev.map((f) => (f.id === fileId ? updated : f)));
        void containerWrite(file.path, content);
        await maybeReinstall(file, content);
        saved++;
      }
      setEditedContents({});
      toast.success(saved === 1 ? "Saved 1 file" : `Saved ${saved} files`);
      setTimeout(() => refresh({ silent: true }), 0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save all");
    } finally {
      setSaving(false);
    }
  }, [projectId, refresh, containerWrite, maybeReinstall]);

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
          void containerWrite(closeTarget.path, val);
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
  }, [closeTarget, editedContents, projectId, openFiles, activeFileId, containerWrite]);

  const handleCreate = useCallback(async (parentId: string | null, isFolder: boolean, name: string) => {
    const unique = getUniqueName(name, parentId, filesRef.current);
    pushHistory([...filesRef.current]);
    try {
      const created = await api.post<ProjectFile>(`/api/projects/${projectId}/files`, {
        name: unique, parentId, isFolder, content: isFolder ? null : "",
      });
      const file: ProjectFile = (created as unknown as ProjectFile) ?? (created as unknown as { data: ProjectFile }).data ?? (created as unknown as ProjectFile);
      await refresh({ silent: true });
      // Mirror into the container FS (best effort).
      const createdPath =
        (file as ProjectFile)?.path ??
        (created as unknown as { data?: ProjectFile })?.data?.path;
      if (createdPath && containerReadyRef.current) {
        if (isFolder) {
          runtime.mkdir(createdPath).catch(() => toast.error("Sync to runtime failed"));
        } else {
          void containerWrite(createdPath, "");
          ensureFileModel(createdPath, "", unique);
        }
      }
      if (parentId) setExpanded((s) => new Set(s).add(parentId));
      if (file?.id && !isFolder) handleOpenFile(file);
      toast.success(`${isFolder ? "Folder" : "File"} created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create");
    }
  }, [projectId, pushHistory, refresh, handleOpenFile, containerWrite, runtime, ensureFileModel]);

  const handleRename = useCallback(async (file: ProjectFile, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === file.name) return;
    const unique = getUniqueName(trimmed, file.parentId, filesRef.current.filter((f) => f.id !== file.id));
    const oldPath = file.path;
    const parentDir = dirOf(oldPath);
    const newPath = parentDir ? `${parentDir}/${unique}` : unique;
    // Unsaved edits travel with the rename so the container keeps latest.
    const currentContent = editedContentsRef.current[file.id] ?? file.content ?? "";
    const oldSubtree = file.isFolder
      ? filesUnder(filesRef.current, oldPath).map((f) => f.path)
      : [];
    pushHistory([...filesRef.current]);
    setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, name: unique } : f)));
    setOpenFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, name: unique } : f)));
    try {
      await api.put(`/api/projects/${projectId}/files/${file.id}`, { name: unique });
      const arr = await refresh({ silent: true });
      if (containerReadyRef.current) {
        if (file.isFolder) {
          await containerRemove(oldPath);
          for (const f of filesUnder(arr, newPath)) {
            const pending = editedContentsRef.current[f.id];
            const content = pending ?? f.content ?? "";
            await containerWrite(f.path, content);
            ensureFileModel(f.path, content, f.name);
          }
        } else {
          workspaceRef.current?.deleteFile(oldPath);
          removeModelByPath(oldPath);
          if (containerReadyRef.current) {
            try {
              await runtime.rm(oldPath, false);
            } catch {
              toast.error("Sync to runtime failed");
            }
          }
          await containerWrite(newPath, currentContent);
          ensureFileModel(newPath, currentContent, unique);
        }
        // Drop stale models for renamed folder contents.
        for (const p of oldSubtree) removeModelByPath(p);
      }
      toast.success("Renamed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rename failed");
      await refresh({ silent: true });
    }
  }, [projectId, pushHistory, refresh, containerWrite, containerRemove, runtime, ensureFileModel]);

  const handleDelete = useCallback(async (file: ProjectFile) => {
    pushHistory([...filesRef.current]);
    const toRemove = new Set(collectDescendants(filesRef.current, file.id));
    const removedPaths = filesRef.current
      .filter((f) => toRemove.has(f.id) && !f.isFolder)
      .map((f) => f.path);
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
      if (containerReadyRef.current) {
        for (const p of removedPaths) {
          workspaceRef.current?.deleteFile(p);
          removeModelByPath(p);
        }
        try {
          await runtime.rm(file.path, true);
        } catch {
          toast.error("Sync to runtime failed");
        }
      }
      toast.success("Deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
      await refresh({ silent: true });
    }
  }, [projectId, pushHistory, refresh, activeFileId, openFiles, runtime]);

  const handleDuplicate = useCallback(async (file: ProjectFile) => {
    const parentId = file.parentId;
    const unique = getUniqueName(file.name, parentId, filesRef.current);
    const newPath = childPath(filesRef.current, parentId, unique);
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
      const arr = await refresh({ silent: true });
      if (containerReadyRef.current) {
        if (file.isFolder) {
          for (const f of filesUnder(arr, newPath)) {
            await containerWrite(f.path, f.content ?? "");
            ensureFileModel(f.path, f.content ?? "", f.name);
          }
        } else {
          await containerWrite(newPath, file.content ?? "");
          ensureFileModel(newPath, file.content ?? "", unique);
        }
      }
      toast.success("Duplicated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Duplicate failed");
    }
  }, [projectId, pushHistory, refresh, containerWrite, ensureFileModel]);

  const handlePaste = useCallback(async (target: ProjectFile) => {
    if (!clipboard) return;
    const pasteParentId = getPasteParentId(target);
    const src = clipboard.file;
    if (src.isFolder && pasteParentId) {
      const isDesc = src.id === pasteParentId || isDescendant(filesRef.current, src.id, pasteParentId);
      if (isDesc) { toast.error("Cannot paste folder into itself"); return; }
    }
    const oldPath = src.path;
    const oldSubtree = src.isFolder
      ? filesUnder(filesRef.current, oldPath).map((f) => f.path)
      : [];
    pushHistory([...filesRef.current]);
    let newPath: string | null = null;
    try {
      if (clipboard.op === "cut") {
        const unique = getUniqueName(src.name, pasteParentId, filesRef.current.filter((f) => f.id !== src.id));
        newPath = childPath(filesRef.current, pasteParentId, unique);
        await api.put(`/api/projects/${projectId}/files/${src.id}/move`, { parentId: pasteParentId, name: unique });
        setClipboard(null);
      } else {
        const unique = getUniqueName(src.name, pasteParentId, filesRef.current);
        newPath = childPath(filesRef.current, pasteParentId, unique);
        await api.post(`/api/projects/${projectId}/files`, { name: unique, parentId: pasteParentId, isFolder: src.isFolder, content: src.content });
      }
      const arr = await refresh({ silent: true });
      if (containerReadyRef.current && newPath) {
        if (clipboard.op === "cut") {
          await containerRemove(oldPath);
          removeModelByPath(oldPath);
          for (const p of oldSubtree) removeModelByPath(p);
        }
        if (src.isFolder) {
          for (const f of filesUnder(arr, newPath)) {
            const pending = editedContentsRef.current[f.id];
            const content = pending ?? f.content ?? "";
            await containerWrite(f.path, content);
            ensureFileModel(f.path, content, f.name);
          }
        } else {
          const content = clipboard.op === "cut"
            ? (editedContentsRef.current[src.id] ?? src.content ?? "")
            : (src.content ?? "");
          await containerWrite(newPath, content);
          ensureFileModel(newPath, content, src.name);
        }
      }
      if (pasteParentId) setExpanded((s) => new Set(s).add(pasteParentId));
      toast.success("Pasted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Paste failed");
    }
  }, [clipboard, projectId, pushHistory, refresh, containerWrite, containerRemove, ensureFileModel]);

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
  }, [handleDuplicate, handlePaste]);

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

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (e: MouseEvent) => {
      const diff = e.clientX - startX;
      const newWidth = Math.min(Math.max(startWidth + diff, 180), 500);
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [sidebarWidth]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <aside
        style={{ width: sidebarWidth }}
        className="shrink-0 border-r flex flex-col overflow-hidden bg-card"
      >
        <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Explorer</span>
          <span className="text-[11px]">{clipboard ? `${clipboard.op}: ${clipboard.file.name}` : ""}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
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

      <div
        onMouseDown={handleResizeStart}
        className={`w-1 shrink-0 cursor-col-resize hover:bg-primary/20 transition-colors ${isResizing ? "bg-primary/20" : ""}`}
      />

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
            <button
              onClick={() => setShowProblems((v) => !v)}
              className={`rounded px-2 py-1 ${showProblems ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              title="Toggle Problems panel"
            >
              Problems
              {problemCounts.errors + problemCounts.warnings > 0 &&
                ` (${problemCounts.errors + problemCounts.warnings})`}
            </button>
            <span className={saving ? "text-muted-foreground" : isActiveDirty ? "text-yellow-600" : "text-muted-foreground"}>
              {saving ? "Saving..." : isActiveDirty ? "● Unsaved" : "Saved"}
            </span>
            <button
              onClick={handleSaveAll}
              disabled={Object.keys(editedContents).length === 0 || saving}
              className="rounded border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
              title="Save all dirty files"
            >
              Save All
              {Object.keys(editedContents).length > 1 &&
                ` (${Object.keys(editedContents).length})`}
            </button>
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
              template={template}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file to begin editing.</div>
          )}
        </div>
        {showProblems && (
          <div
            className="shrink-0 border-t bg-background"
            style={{ height: problemsHeight }}
          >
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingProblems(true);
                const startY = e.clientY;
                const startHeight = problemsHeight;

                const handleMouseMove = (moveEvent: MouseEvent) => {
                  const diff = moveEvent.clientY - startY;
                  setProblemsHeight(
                    Math.min(Math.max(startHeight - diff, 100), 500),
                  );
                };
                const handleMouseUp = () => {
                  setIsResizingProblems(false);
                  document.removeEventListener("mousemove", handleMouseMove);
                  document.removeEventListener("mouseup", handleMouseUp);
                };

                document.addEventListener("mousemove", handleMouseMove);
                document.addEventListener("mouseup", handleMouseUp);
              }}
              className={`h-1 w-full cursor-row-resize transition-colors hover:bg-primary/20 ${isResizingProblems ? "bg-primary/20" : ""}`}
            />
            <div className="h-[calc(100%-4px)]">
              <ProblemsPanel
                onSelectProblem={handleSelectProblem}
                refreshToken={openFiles.length}
                onCountChange={(errors, warnings) =>
                  setProblemCounts({ errors, warnings })
                }
              />
            </div>
          </div>
        )}
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
