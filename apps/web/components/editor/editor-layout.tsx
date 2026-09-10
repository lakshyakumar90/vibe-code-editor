"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { useTheme } from "next-themes";
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
import { BottomPanel } from "./bottom-panel";
import { AIPanel } from "./ai-panel";
import { InlineSettingsButton } from "./inline-settings";
import { PreviewPanel } from "./preview-panel";
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
import { X, Circle, Search, ChevronRight, PanelLeftClose, PanelLeftOpen, Check, Sparkles } from "lucide-react";
import type { Attachment } from "@repo/ai";
import type { AskAISelection } from "./code-editor";
import { applyChangeSet, fetchChangeSet, rejectChangeSet, type FileDiff } from "@/lib/ai/diff";
import type { VerifyFile } from "@/lib/ai/types";

interface EditorLayoutProps {
  projectId: string;
  /** Project template — drives runtime commands + TS config. */
  template?: string;
  agentOpen?: boolean;
  onAgentChange?: (open: boolean) => void;
  view?: "code" | "preview";
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

export function EditorLayout({ projectId, template = "REACT", agentOpen = true, onAgentChange, view = "code" }: EditorLayoutProps) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [openFiles, setOpenFiles] = useState<ProjectFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [editedContents, setEditedContents] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [inlineEnabled, setInlineEnabled] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<{ op: "cut" | "copy"; file: ProjectFile } | null>(null);
  const [history, setHistory] = useState<ProjectFile[][]>([]);
  const [future, setFuture] = useState<ProjectFile[][]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{ parentId: string | null; isFolder: boolean; value: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectFile | null>(null);
  const [closeTarget, setCloseTarget] = useState<ProjectFile | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(288);
  const [aiWidth, setAiWidth] = useState(340);
  const aiCollapsed = !agentOpen;
  const setAiCollapsed = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      const next = typeof v === "function" ? v(!agentOpen) : v;
      onAgentChange?.(!next);
    },
    [agentOpen, onAgentChange],
  );
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [leftTab, setLeftTab] = useState<"files" | "search">("files");
  const [searchQuery, setSearchQuery] = useState("");
  const filesRef = useRef(files);
  filesRef.current = files;
  const editedContentsRef = useRef(editedContents);
  editedContentsRef.current = editedContents;

  // --- WebContainer / workspace sync (Steps 0+1+6) ---
  const { runtime, bootAndMount, runBootChain, reinstallAndRestart, restartDev, status: runtimeStatus } = useRuntime();
  const workspaceRef = useRef<VirtualWorkspace | null>(null);
  const pathToIdRef = useRef<Map<string, string>>(new Map());
  const bootedRef = useRef(false);
  const startedRef = useRef(false);
  const containerReadyRef = useRef(false);
  const depHashRef = useRef<string>("");

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

  // Boot the runtime once files arrive: workspace -> mount, then
  // `npm install && npm run dev` runs in the boot terminal's foreground
  // shell (Ctrl+C / closing it stops the dev server + preview).
  // Structural edits later only mirror (no reinstall/remount).
  // Re-runs after a provider reset() (status back to idle) for manual retry.
  useEffect(() => {
    if (files.length === 0 || bootedRef.current) return;
    if (runtimeStatus !== "idle") return;
    bootedRef.current = true;
    const snapshot = [...files];
    workspaceRef.current = createWorkspace(snapshot);
    pathToIdRef.current = buildPathToId(snapshot);
    void (async () => {
      try {
        await bootAndMount(snapshot.map((f) => ({ path: f.path, content: f.content, isFolder: f.isFolder })));
        containerReadyRef.current = true;
        const packageJson =
          workspaceRef.current?.getFile("package.json") ?? "";
        depHashRef.current = hashPackageJson(packageJson);
        await runBootChain();
        startedRef.current = true;
      } catch {
        // status/error surface in PreviewPanel via the provider
        bootedRef.current = false;
        containerReadyRef.current = false;
      }
    })();
  }, [files, bootAndMount, runBootChain, runtime, template, runtimeStatus]);

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
    // Typing only marks the file dirty (in-memory workspace mirrors it so
    // the editor stays coherent). The container FS — and therefore Vite
    // HMR — updates on Save only, never while typing.
    const target = filesRef.current.find((f) => f.id === fileId);
    if (target && !target.isFolder) {
      workspaceRef.current?.updateFile(target.path, newValue);
    }
  }, []);

  // Ask-AI selections captured from the editor (right-click menu).
  // Passed down as attachment chips; the left agent rail expands.
  const [aiAttachments, setAiAttachments] = useState<Attachment[]>([]);

  const handleAskAI = useCallback((selection: AskAISelection) => {
    if (!selection.code.trim()) {
      toast.info("Select some code first");
      return;
    }
    setAiCollapsed(false);
    setAiAttachments((prev) => {
      if (
        prev.some(
          (a) =>
            a.filePath === selection.filePath &&
            a.startLine === selection.startLine &&
            a.endLine === selection.endLine,
        )
      ) {
        return prev;
      }
      return [...prev.slice(-9), { ...selection }];
    });
  }, [setAiCollapsed]);

  const handleAiAttachmentsConsumed = useCallback(() => {
    setAiAttachments([]);
  }, []);

  /** Reinstall + restart when package.json content actually changed. */
  const maybeReinstall = useCallback(async (file: ProjectFile, content: string) => {
    if (file.name !== "package.json" || !startedRef.current) return;
    const newHash = hashPackageJson(content);
    if (depHashRef.current && newHash !== depHashRef.current) {
      depHashRef.current = newHash;
      toast.info("Dependencies changed — reinstalling…");
      try {
        // Runs in the boot terminal (Ctrl+C, reinstall, restart dev);
        // falls back to detached processes when no boot shell exists.
        await reinstallAndRestart();
        toast.success("Dependencies updated");
      } catch {
        toast.error("Reinstall failed");
      }
    } else {
      depHashRef.current = newHash;
    }
  }, [reinstallAndRestart]);

  // Phase 4 — pending agent changeset under review. Files stay untouched
  // (DB + container + models) until per-file Accept; Reject discards.
  const [pendingReview, setPendingReview] = useState<{
    changeSetId: string;
    diffs: FileDiff[];
  } | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  // Proposed NEW file (no DB record yet) open in the diff preview pane.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "vs";

  const handleChangesetReady = useCallback(async (changeSetId: string) => {
    setReviewBusy(true);
    try {
      const { diffs } = await fetchChangeSet(changeSetId);
      if (diffs.length === 0) {
        toast.info("Changeset is empty");
        return;
      }
      setPendingReview({ changeSetId, diffs });
      toast.success(`Reviewing AI changeset (${diffs.length} files)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load changeset");
    } finally {
      setReviewBusy(false);
    }
  }, []);

  /** Mirror accepted files to the container, then re-sync from DB truth. */
  const syncAppliedFiles = useCallback(
    async (applied: string[], diffs: FileDiff[]) => {
      const byPath = new Map(diffs.map((d) => [d.path, d]));
      for (const path of applied) {
        const diff = byPath.get(path);
        if (!diff) continue;
        if (diff.isFolder && !diff.deleted) {
          // Folder create: mkdir in the container (a writeFile with null
          // content here would create a *file* at the folder path).
          // Drop any phantom workspace entry from earlier buggy syncs —
          // the workspace map never stores folders.
          workspaceRef.current?.deleteFile(path);
          removeModelByPath(path);
          try {
            await runtime.mkdir(path);
          } catch {
            toast.error("Sync to runtime failed");
          }
        } else if (diff.deleted || diff.newContent === null) {
          await containerRemove(path);
        } else {
          await containerWrite(path, diff.newContent);
        }
      }
      // Drop stale dirty state first, then refresh once from DB truth
      // and return it so callers can open newly created files.
      const ids = new Set(
        filesRef.current
          .filter((f) => !f.isFolder && applied.includes(f.path))
          .map((f) => f.id),
      );
      setEditedContents((prev) => {
        const next = { ...prev };
        ids.forEach((id) => {
          delete next[id];
        });
        return next;
      });
      // truth so callers can open newly created files.
      const arr = await refresh({ silent: true });
      return arr;
    },
    [containerWrite, containerRemove, refresh, runtime],
  );

  /**
   * Run an agent-approved terminal command in the project WebContainer,
   * then sync the container's package.json back to the DB (npm install
   * mutates it in the container only, but the DB is truth — without this
   * later reads and applies would use stale dependency data).
   */
  const handleExecuteCommand = useCallback(
    async (command: string) => {
      if (!containerReadyRef.current) {
        throw new Error("Runtime is still starting — wait for boot, then Run again");
      }
      const res = await runtime.runCommand(command);
      try {
        const containerPkg = await runtime.readContainerFile("package.json");
        const dbPkg = filesRef.current.find((f) => !f.isFolder && f.path === "package.json");
        if (containerPkg !== null && dbPkg && containerPkg !== (dbPkg.content ?? "")) {
          await api.put(`/api/projects/${projectId}/files/${dbPkg.id}`, {
            content: containerPkg,
          });
          await refresh({ silent: true });
          depHashRef.current = hashPackageJson(containerPkg);
          toast.success("package.json synced from terminal");
          try {
            await restartDev();
          } catch {
            toast.error("Preview restart failed — check the terminal tab");
          }
        }
      } catch (e) {
        if (e instanceof Error && /starting/i.test(e.message)) throw e;
        toast.error(e instanceof Error ? e.message : "Failed to sync package.json");
      }
      return res;
    },
    [runtime, projectId, refresh, restartDev],
  );

  /**
   * Build verification for an agent changeset: temp-apply candidate files to
   * the container, run the template build, then restore the container to DB
   * truth. Nothing is written to the DB here — review/apply still gates all
   * real changes. The preview may flicker while candidates are applied.
   */
  const handleVerifyBuild = useCallback(
    async (files: VerifyFile[]) => {
      if (!containerReadyRef.current) {
        throw new Error("Runtime is still starting — wait for boot, then Run again");
      }
      const command = runtime.buildCommand().join(" ");
      const dbFiles = filesRef.current.filter((f) => !f.isFolder);
      const dbPaths = new Set(filesRef.current.map((f) => f.path));
      // Snapshot every DB file the candidate touches (equality or below a
      // candidate path) so restore is exact.
      const snapshot = new Map<string, string | null>();
      for (const f of dbFiles) {
        if (files.some((c) => f.path === c.path || f.path.startsWith(`${c.path}/`))) {
          snapshot.set(f.path, await runtime.readContainerFile(f.path));
        }
      }
      const restore = async () => {
        for (const [path, content] of snapshot) {
          try {
            if (content === null) await runtime.rm(path);
            else await runtime.writeFile(path, content);
          } catch {
            // best-effort — container already warned on real failures
          }
        }
        for (const c of files) {
          try {
            if (c.isFolder) {
              if (!c.delete && !dbPaths.has(c.path)) await runtime.rm(c.path);
            } else if (!snapshot.has(c.path)) {
              await runtime.rm(c.path);
            }
          } catch {
            // best-effort cleanup
          }
        }
      };
      try {
        for (const c of files) {
          if (c.isFolder) {
            if (c.delete) await runtime.rm(c.path);
            else await runtime.mkdir(c.path);
          } else if (c.delete || c.content === null) {
            await runtime.rm(c.path);
          } else {
            await runtime.writeFile(c.path, c.content);
          }
        }
        const res = await runtime.runCommand(command);
        if (res.exitCode === 0) toast.success("Build passed");
        else toast.error(`Build failed (exit ${res.exitCode})`);
        // Manifest first: proves to the agent (and you) the build ran
        // WITH the candidate files applied — not against stale code.
        const applied = files.map((c) => c.path).join(", ");
        const manifest = `[verify] temp-applied ${files.length} file(s) to container (${applied}); ran "${command}"; container restored.`;
        return { command, output: `${manifest}\n\n${res.output}`, exitCode: res.exitCode };
      } finally {
        await restore();
      }
    },
    [runtime],
  );

  const handleAcceptFiles = useCallback(
    async (paths?: string[]) => {
      if (!pendingReview) return;
      setReviewBusy(true);
      try {
        const res = await applyChangeSet(pendingReview.changeSetId, paths);
        const fresh = await syncAppliedFiles(res.files, pendingReview.diffs);
        // Agent changesets can carry dependency changes — same reinstall
        // path as manual package.json saves (terminal installs already
        // ran; this covers the direct-edit fallback).
        const acceptedPkg = pendingReview.diffs.find(
          (d) => !d.deleted && !d.isFolder && d.path.split("/").pop() === "package.json" && d.newContent !== null,
        );
        if (acceptedPkg?.newContent != null) {
          await maybeReinstall({ name: "package.json" } as ProjectFile, acceptedPkg.newContent);
        }
        if (res.status === "applied") {
          setPendingReview(null);
          setPreviewPath(null);
          toast.success(
            res.files.length === 1 ? "Applied 1 file" : `Applied ${res.files.length} files`,
          );
        } else {
          const remaining = new Set(res.remaining);
          setPendingReview((prev) =>
            prev
              ? { ...prev, diffs: prev.diffs.filter((d) => remaining.has(d.path)) }
              : prev,
          );
          setPreviewPath((prev) => (prev && remaining.has(prev) ? prev : null));
          toast.success(`Applied ${res.files.length} files (${res.remaining.length} remaining)`);
        }
        // Newly created files now exist — open the previewed one (or the
        // first created) so it shows in the UI immediately.
        const targetPath =
          (previewPath && res.files.includes(previewPath) && previewPath) ??
          res.files.find((p) => !openFiles.some((f) => f.path === p));
        if (targetPath) {
          const created = fresh.find((f) => !f.isFolder && f.path === targetPath);
          if (created) {
            setPreviewPath(null);
            handleOpenFile(created);
          }
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to apply");
      } finally {
        setReviewBusy(false);
      }
    },
    [pendingReview, syncAppliedFiles, previewPath, openFiles, handleOpenFile, maybeReinstall],
  );

  const handleRejectFiles = useCallback(
    async (paths?: string[]) => {
      if (!pendingReview) return;
      setReviewBusy(true);
      try {
        const res = await rejectChangeSet(pendingReview.changeSetId, paths);
        if (res.status === "rejected") {
          setPendingReview(null);
          // Rejected proposals vanish — nothing was ever created, so
          // there is nothing to undo beyond dropping the preview.
          setPreviewPath(null);
          toast.success("Changeset rejected");
        } else {
          const remaining = new Set(res.remaining ?? []);
          setPendingReview((prev) =>
            prev
              ? { ...prev, diffs: prev.diffs.filter((d) => remaining.has(d.path)) }
              : prev,
          );
          setPreviewPath((prev) => (prev && remaining.has(prev) ? prev : null));
          toast.success("Files rejected");
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to reject");
      } finally {
        setReviewBusy(false);
      }
    },
    [pendingReview],
  );

  /**
   * Open a changeset file from the agent panel card (Cursor-style).
   * Existing files open in the editor; proposed new files (no record yet)
   * open in the diff preview pane — same as clicking the review strip.
   */
  const handleOpenPanelFile = useCallback(
    (path: string) => {
      const target = filesRef.current.find((f) => !f.isFolder && f.path === path);
      if (target) {
        setPreviewPath(null);
        handleOpenFile(target);
        return;
      }
      const diff = pendingReview?.diffs.find(
        (d) => d.path === path && !d.deleted && d.newContent !== null && !d.isFolder,
      );
      if (diff) {
        setPreviewPath(diff.path);
        return;
      }
      // Changeset not loaded yet (event arrived before fetch finished) —
      // the review strip will have it; nudge instead of going silent.
      toast.info(diff === undefined && pendingReview === null ? "Loading changeset…" : `Nothing to preview for ${path}`);
    },
    [handleOpenFile, pendingReview],
  );

  const handleOpenReviewFile = useCallback(
    (diff: FileDiff) => {
      if (diff.isFolder) {
        toast.info("Folders apply from here — Accept to create or remove");
        return;
      }
      const target = filesRef.current.find((f) => !f.isFolder && f.path === diff.path);
      if (target) {
        setPreviewPath(null);
        handleOpenFile(target);
        return;
      }
      if (!diff.deleted && diff.newContent !== null) {
        // Proposed new file: no DB record yet — show empty → content
        // in the diff preview pane instead of blocking with a toast.
        setPreviewPath(diff.path);
        return;
      }
      toast.info("Nothing to preview for this entry");
    },
    [handleOpenFile],
  );

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

  /** Dispose the Monaco model for a closed file (one model per open file). */
  const disposeFileModel = useCallback((file: ProjectFile) => {
    removeModelByPath(file.path);
  }, []);

  /** Discard unsaved edits for the active file (Reset). */
  const handleReset = useCallback(() => {
    if (!activeFile) return;
    setEditedContents((prev) => {
      if (prev[activeFile.id] === undefined) return prev;
      const next = { ...prev };
      delete next[activeFile.id];
      return next;
    });
    workspaceRef.current?.updateFile(activeFile.path, activeFile.content ?? "");
    void containerWrite(activeFile.path, activeFile.content ?? "");
    toast.info("Changes discarded");
  }, [activeFile, containerWrite]);

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
      disposeFileModel(file);
      if (activeFileId === file.id) {
        const remaining = openFiles.filter((f) => f.id !== file.id);
        setActiveFileId(remaining.length ? remaining.at(-1)?.id ?? null : null);
      }
    }
  }, [editedContents, openFiles, activeFileId, disposeFileModel]);

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
    const path = closeTarget.path;
    setOpenFiles((prev) => prev.filter((f) => f.id !== id));
    setEditedContents((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    removeModelByPath(path);
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
        }
      }
      if (parentId) setExpanded((s) => new Set(s).add(parentId));
      if (file?.id && !isFolder) handleOpenFile(file);
      toast.success(`${isFolder ? "Folder" : "File"} created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create");
    }
  }, [projectId, pushHistory, refresh, handleOpenFile, containerWrite, runtime]);

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
        }
        // Drop stale models for renamed folder contents.
        for (const p of oldSubtree) removeModelByPath(p);
      }
      toast.success("Renamed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rename failed");
      await refresh({ silent: true });
    }
  }, [projectId, pushHistory, refresh, containerWrite, containerRemove, runtime]);

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
          }
        } else {
          await containerWrite(newPath, file.content ?? "");
        }
      }
      toast.success("Duplicated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Duplicate failed");
    }
  }, [projectId, pushHistory, refresh, containerWrite]);

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
          }
        } else {
          const content = clipboard.op === "cut"
            ? (editedContentsRef.current[src.id] ?? src.content ?? "")
            : (src.content ?? "");
          await containerWrite(newPath, content);
        }
      }
      if (pasteParentId) setExpanded((s) => new Set(s).add(pasteParentId));
      toast.success("Pasted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Paste failed");
    }
  }, [clipboard, projectId, pushHistory, refresh, containerWrite, containerRemove]);

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

  const visibleFiles =
    leftTab === "search" && searchQuery.trim()
      ? files.filter(
          (f) =>
            !f.isFolder &&
            f.path.toLowerCase().includes(searchQuery.trim().toLowerCase()),
        )
      : files;

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left agent rail — fully unmounted when collapsed (no stub bar).
          Reopen via the Agent buttons in the view bar below the navbar. */}
      {!aiCollapsed && (
        <>
          <aside
            style={{ width: aiWidth }}
            className="flex shrink-0 flex-col overflow-hidden border-r bg-background"
          >
            <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
              <span className="px-1 text-sm font-bold italic tracking-tight">vibe</span>
              <span className="flex-1" />
              <button
                onClick={() => setAiCollapsed(true)}
                className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Collapse agent panel"
              >
                <PanelLeftClose className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <AIPanel
                projectId={projectId}
                attachables={openFiles
                  .filter((f) => !f.isFolder)
                  .map((f) => ({
                    id: f.id,
                    path: f.path,
                    content: editedContents[f.id] ?? f.content ?? "",
                  }))}
                externalAttachments={aiAttachments}
                onExternalConsumed={handleAiAttachmentsConsumed}
                onChangeset={handleChangesetReady}
                onOpenFile={handleOpenPanelFile}
                onExecuteCommand={handleExecuteCommand}
                onVerifyBuild={handleVerifyBuild}
              />
            </div>
          </aside>
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = aiWidth;
              const move = (ev: MouseEvent) =>
                setAiWidth(Math.min(Math.max(startW + ev.clientX - startX, 260), 560));
              const up = () => {
                document.removeEventListener("mousemove", move);
                document.removeEventListener("mouseup", up);
              };
              document.addEventListener("mousemove", move);
              document.addEventListener("mouseup", up);
            }}
            className="w-1 shrink-0 cursor-col-resize transition-colors hover:bg-primary/20"
          />
        </>
      )}
      {view === "code" && !sidebarCollapsed && (
        <>
          <aside
            style={{ width: sidebarWidth }}
            className="shrink-0 border-r flex flex-col overflow-hidden bg-card"
          >
            <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <button
                onClick={() => setLeftTab("files")}
                className={`flex items-center gap-1.5 rounded px-2 py-1 ${leftTab === "files" ? "bg-accent text-foreground" : "hover:text-foreground"}`}
              >
                Files
              </button>
              <button
                onClick={() => setLeftTab("search")}
                className={`flex items-center gap-1.5 rounded px-2 py-1 ${leftTab === "search" ? "bg-accent text-foreground" : "hover:text-foreground"}`}
              >
                Search
              </button>
              <span className="flex-1" />
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="rounded p-1 hover:bg-accent hover:text-foreground"
                title="Collapse panel"
              >
                <PanelLeftClose className="size-4" />
              </button>
            </div>
            {leftTab === "search" && (
              <div className="shrink-0 border-b p-2">
                <div className="flex items-center gap-2 rounded border bg-background px-2 py-1.5 text-xs">
                  <Search className="size-3.5 shrink-0 text-muted-foreground" />
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search files…"
                    className="w-full bg-transparent outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
              {loading ? <div className="p-4 text-sm">Loading files...</div> : (
                <FileTree
                  projectId={projectId}
                  files={visibleFiles}
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
            {clipboard && (
              <div className="shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                {clipboard.op}: {clipboard.file.name}
              </div>
            )}
          </aside>

          <div
            onMouseDown={handleResizeStart}
            className={`w-1 shrink-0 cursor-col-resize hover:bg-primary/20 transition-colors ${isResizing ? "bg-primary/20" : ""}`}
          />
        </>
      )}

      <main className="min-w-0 flex flex-1 flex-col overflow-hidden bg-background">
        {/* Both views stay mounted so the preview iframe never reloads
            and terminal shells survive Code <-> Preview switches. Only
            visibility toggles. */}
        <div className={`min-h-0 flex-1 ${view === "preview" ? "" : "hidden"}`}>
          <PreviewPanel fullscreen />
        </div>
        <div className={`flex min-h-0 flex-1 flex-col ${view === "code" ? "" : "hidden"}`}>
        {sidebarCollapsed && (
          <div className="flex h-9 shrink-0 items-center border-b bg-muted/40 px-2">
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Expand file panel"
            >
              <PanelLeftOpen className="size-4" />
            </button>
          </div>
        )}
        {/* Tabbed editor area */}
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
        {/* Breadcrumb + Save/Reset */}
        {activeFile && (
          <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b bg-background px-4 text-xs">
            <nav className="flex min-w-0 items-center gap-1 truncate text-muted-foreground" aria-label="Breadcrumb">
              {activeFile.path.split("/").map((part, i, arr) => (
                <span key={i} className="flex shrink-0 items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3 text-muted-foreground/60" />}
                  <span className={i === arr.length - 1 ? "font-medium text-foreground" : ""}>
                    {part}
                  </span>
                </span>
              ))}
            </nav>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => setInlineEnabled((v) => !v)}
                className={`flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-accent ${inlineEnabled ? "text-foreground" : "text-muted-foreground opacity-60"}`}
                title={inlineEnabled ? "AI completions on (click to disable)" : "AI completions off (click to enable)"}
              >
                <Sparkles className="size-3.5" />
                AI
              </button>
              <InlineSettingsButton />
              <span className={saving ? "text-muted-foreground" : isActiveDirty ? "text-yellow-600" : "text-muted-foreground"}>
                {saving ? "Saving..." : isActiveDirty ? "● Unsaved" : "Saved"}
              </span>
              <button
                onClick={handleReset}
                disabled={!isActiveDirty || saving}
                className="rounded border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
                title="Discard unsaved changes"
              >
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={!isActiveDirty || saving}
                className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Save (Ctrl+S)
              </button>
            </div>
          </div>
        )}
        {/* Pending agent changeset under review (Phase 4). */}
        {pendingReview && pendingReview.diffs.length > 0 && (
          <div className="shrink-0 border-b bg-muted/30 px-4 py-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">
                AI changeset — {pendingReview.diffs.length} file
                {pendingReview.diffs.length === 1 ? "" : "s"} pending
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => handleAcceptFiles()}
                  disabled={reviewBusy}
                  className="rounded bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Accept all
                </button>
                <button
                  onClick={() => handleRejectFiles()}
                  disabled={reviewBusy}
                  className="rounded border px-2.5 py-1 hover:bg-accent disabled:opacity-50"
                >
                  Reject all
                </button>
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {pendingReview.diffs.map((diff) => {
                const isNew = diff.oldContent === null && !diff.deleted;
                const badge = diff.deleted ? (
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-500">
                    Deleted
                  </span>
                ) : isNew ? (
                  <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-500">
                    New
                  </span>
                ) : (
                  <span className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-600">
                    Modified
                  </span>
                );
                return (
                  <span
                    key={diff.path}
                    className="flex max-w-full items-center gap-1.5 rounded-md border bg-background py-1 pl-2 pr-1 text-[11px]"
                  >
                    <button
                      onClick={() => handleOpenReviewFile(diff)}
                      className="flex min-w-0 items-center gap-1.5 hover:underline disabled:no-underline disabled:opacity-70"
                      disabled={diff.isFolder}
                      title={diff.isFolder ? `${diff.path} (folder)` : isNew ? diff.path : `Open ${diff.path} diff`}
                    >
                      {getFileIcon(diff.path.split("/").pop() ?? diff.path, diff.isFolder, false)}
                      <span className="truncate">{diff.path}</span>
                    </button>
                    {badge}
                    <button
                      onClick={() => handleAcceptFiles([diff.path])}
                      disabled={reviewBusy}
                      className="rounded p-0.5 text-green-600 hover:bg-accent disabled:opacity-50"
                      title={`Accept ${diff.path}`}
                      aria-label={`Accept ${diff.path}`}
                    >
                      <Check className="size-3.5" />
                    </button>
                    <button
                      onClick={() => handleRejectFiles([diff.path])}
                      disabled={reviewBusy}
                      className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                      title={`Reject ${diff.path}`}
                      aria-label={`Reject ${diff.path}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {(() => {
            // Proposed-new-file preview: no DB record yet, so render the
            // diff directly (empty → proposed content) with Accept/Reject.
            const previewDiff =
              previewPath && !openFiles.some((f) => f.path === previewPath)
                ? (pendingReview?.diffs.find(
                    (d) =>
                      d.path === previewPath && !d.deleted && d.newContent !== null && !d.isFolder,
                  ) ?? null)
                : null;
            if (previewDiff) {
              return (
                <div className="flex h-full flex-col">
                  <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b bg-muted/30 px-4 text-xs">
                    <span className="truncate text-muted-foreground">
                      Previewing proposed file{" "}
                      <span className="font-medium text-foreground">{previewDiff.path}</span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        onClick={() => handleAcceptFiles([previewDiff.path])}
                        disabled={reviewBusy}
                        className="rounded bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        Accept & create
                      </button>
                      <button
                        onClick={() => handleRejectFiles([previewDiff.path])}
                        disabled={reviewBusy}
                        className="rounded border px-2.5 py-1 hover:bg-accent disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => setPreviewPath(null)}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="Close preview"
                        aria-label="Close preview"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1">
                    <DiffEditor
                      height="100%"
                      theme={monacoTheme}
                      language={getLanguage(previewDiff.path.split("/").pop() ?? previewDiff.path)}
                      original=""
                      modified={previewDiff.newContent ?? ""}
                      options={{
                        automaticLayout: true,
                        minimap: { enabled: false },
                        fontSize: 14,
                        readOnly: true,
                        renderSideBySide: false,
                        scrollBeyondLastLine: false,
                        wordWrap: "on",
                      }}
                    />
                  </div>
                </div>
              );
            }
            return activeFile ? (
            <CodeEditor
              projectId={projectId}
              file={activeFile}
              value={activeValue}
              onChange={(v) => handleContentChange(activeFile.id, v)}
              onSave={handleSave}
              saving={saving}
              onAskAI={handleAskAI}
              inlineEnabled={inlineEnabled}
              reviewDiff={
                pendingReview?.diffs.find((d) => d.path === activeFile.path) ?? null
              }
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file to begin editing.</div>
          );
          })()}
        </div>
        <BottomPanel />
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
