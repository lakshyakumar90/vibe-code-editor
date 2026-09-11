"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import type * as Monaco from "monaco-editor";
import { AWARENESS_THROTTLE_MS, editorDocId } from "@repo/collab";
import type {
  EditorAwarenessBroadcast,
  EditorJoinedMessage,
  EditorRelAnchor,
  EditorRemoteUpdateMessage,
} from "@repo/collab";
import type { ProjectFile } from "@/types/file";
import {
  getSharedEditor,
  getSharedMonaco,
  getModel,
} from "@/lib/language/model-manager";
import {
  CollabClient,
  type CollabConnectionStatus,
} from "@/lib/collab/client";
import type { InboundMessage } from "@/lib/collab/client";
import { DocSessionManager } from "@/lib/collab/doc-session";
import type { DocSession } from "@/lib/collab/doc-session";
import {
  anchorForOffset,
  offsetForAnchor,
} from "@/lib/collab/awareness-rel";
import {
  registerSession,
  unregisterSession,
} from "@/lib/collab/session-registry";
import {
  attachModelBinding,
  type ModelBinding,
} from "@/lib/collab/yjs-monaco";
import {
  RemoteCursorRenderer,
  type RemotePeer,
} from "@/lib/collab/remote-cursors";

export interface CollabBridgeHandle {
  /** Live Yjs text for a file (undefined when no session exists). */
  getLiveContent(fileId: string): string | undefined;
  /**
   * Whole-content replacement through Yjs (Reset-to-saved path).
   * Returns false when no session exists (caller falls back to local).
   */
  applyExternalContent(fileId: string, content: string): boolean;
}

interface CollabBridgeProps {
  projectId: string;
  openFiles: ProjectFile[];
  activeFileId: string | null;
  /**
   * Called for EVERY bound-model change (local typing, remote updates,
   * AI applies) so `editedContents` stays coherent — including for
   * background tabs whose models are detached from the editor.
   */
  onModelContent: (fileId: string, text: string) => void;
  onSyncError?: (message: string) => void;
}

/** Trailing-edge throttle for awareness publishes. */
function throttleTrailing(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  return () => {
    pending = true;
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (pending) {
        pending = false;
        fn();
      }
    }, ms);
  };
}

interface FileRecord {
  session: DocSession;
  binding: ModelBinding | null;
  bindingModel: Monaco.editor.ITextModel | null;
  modelSub: Monaco.IDisposable | null;
  /** Y text right after the last `editor.joined` (fold disambiguation). */
  joinedText: string | null;
  /** Doc-update listener that re-renders remote cursors (unsubscribed on dispose). */
  docUpdateHandler: () => void;
}

/**
 * UI-less owner of the Phase 2 editing session. Mounted once per project
 * inside `EditorLayout`; drives `CollabClient` + Yjs sessions + bindings
 * + remote cursors. Monaco models, the save API, AI, and WebContainer are
 * untouched — this layer only observes and relays.
 */
export const CollabBridge = forwardRef<CollabBridgeHandle, CollabBridgeProps>(
  function CollabBridge(
    { projectId, openFiles, activeFileId, onModelContent, onSyncError },
    ref,
  ) {
    const clientRef = useRef<CollabClient | null>(null);
    const sessionsRef = useRef<DocSessionManager | null>(null);
    const recordsRef = useRef(new Map<string, FileRecord>());
    const joinedRef = useRef(new Set<string>());
    const cursorDisposerRef = useRef<Monaco.IDisposable | null>(null);
    const modelListenerDisposerRef = useRef<Monaco.IDisposable | null>(null);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rendererRef = useRef<RemoteCursorRenderer | null>(null);
    const peersRef = useRef(new Map<string, EditorAwarenessBroadcast>());
    /** Last text forwarded per doc — suppresses duplicate notifications. */
    const lastNotifiedRef = useRef(new Map<string, string>());

    const onModelContentRef = useRef(onModelContent);
    onModelContentRef.current = onModelContent;
    const onSyncErrorRef = useRef(onSyncError);
    onSyncErrorRef.current = onSyncError;
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;
    const activeFileIdRef = useRef(activeFileId);
    activeFileIdRef.current = activeFileId;
    const openFilesRef = useRef(openFiles);
    openFilesRef.current = openFiles;

    if (!sessionsRef.current) {
      sessionsRef.current = new DocSessionManager();
    }
    if (!rendererRef.current) {
      rendererRef.current = new RemoteCursorRenderer();
    }

    // -- imperative handle for the layout (save / reset / AI paths) ---------
    useImperativeHandle(ref, () => ({
      getLiveContent(fileId: string): string | undefined {
        const sessions = sessionsRef.current;
        if (!sessions) {
          return undefined;
        }
        const session = sessions.getByFile(projectIdRef.current, fileId);
        // Pre-READY sessions hold partial state (empty / seeding) — the
        // caller must fall back to `editedContents` / DB content instead.
        if (!session || session.currentState !== "READY") {
          return undefined;
        }
        return session.getText();
      },
      applyExternalContent(fileId: string, content: string): boolean {
        const session = sessionsRef.current?.getByFile(
          projectIdRef.current,
          fileId,
        );
        if (!session) {
          return false;
        }
        session.applyExternalContent(content, "external-reset");
        return true;
      },
    }));

    // -- helpers --------------------------------------------------------------
    const sendJoin = (session: DocSession): void => {
      const client = clientRef.current;
      if (!client || client.currentStatus !== "open") {
        return;
      }
      joinedRef.current.add(session.docId);
      const sv = session.getStateVectorBase64();
      client.sendRaw(
        sv
          ? {
              type: "editor.join",
              projectId: session.projectId,
              fileId: session.fileId,
              sv,
            }
          : {
              type: "editor.join",
              projectId: session.projectId,
              fileId: session.fileId,
            },
      );
    };

    const pushDiff = (session: DocSession, serverSv?: string): void => {
      const client = clientRef.current;
      if (!client || client.currentStatus !== "open") {
        return;
      }
      const diff = session.diffAgainst(serverSv);
      if (diff) {
        client.sendRaw({
          type: "editor.update",
          docId: session.docId,
          update: diff,
        });
      }
    };

    const findFile = (fileId: string): ProjectFile | null => {
      const files = openFilesRef.current;
      return files.find((f) => f.id === fileId && !f.isFolder) ?? null;
    };

    /**
     * Bind one open file's model to its session (idempotent). Binding
     * starts at READY so the join snapshot always wins the initial
     * alignment; a three-way comparison decides the direction:
     * - model == Y → just bind.
     * - model == joinedText (untouched since join, Y advanced remotely)
     *   → take Y (model syncs from Y, no broadcast).
     * - otherwise (local typing / AI content landed pre-bind) → fold the
     *   model into Y as a local op so nothing is silently lost.
     */
    const attachRecord = (record: FileRecord, file: ProjectFile): boolean => {
      const editor = getSharedEditor();
      const monaco = getSharedMonaco();
      if (!editor || !monaco) {
        return false;
      }
      const { session } = record;
      if (session.currentState !== "READY") {
        return false;
      }
      const model = getModel(monaco, file.path);
      if (!model) {
        return false;
      }
      if (record.binding && record.bindingModel === model) {
        return true;
      }
      const modelValue = model.getValue();
      const yText = session.getText();
      if (modelValue !== yText) {
        if (record.joinedText !== null && modelValue === record.joinedText) {
          // Untouched since join — take the converged Y state silently.
          // (attachModelBinding syncs model := ytext pre-construction.)
        } else {
          // Local content (pre-join typing, AI apply) — fold into Y so
          // it broadcasts as a normal local op instead of being lost.
          session.applyExternalContent(modelValue, "local-fold");
        }
      }
      record.binding?.destroy();
      record.binding = attachModelBinding(monaco, session.text, model, editor);
      record.bindingModel = model;
      if (!record.modelSub) {
        record.modelSub = model.onDidChangeContent(() => {
          const text = model.getValue();
          // Constructor alignment and binding-driven syncs can emit
          // content events without an actual change — forwarding those
          // would bounce pointless renders through the layout.
          if (lastNotifiedRef.current.get(session.docId) === text) {
            return;
          }
          lastNotifiedRef.current.set(session.docId, text);
          onModelContentRef.current(file.id, text);
        });
      }
      // The alignment setValue inside attach happened before the
      // subscription existed — forward once so React follows immediately
      // instead of waiting for the next keystroke.
      const aligned = model.getValue();
      lastNotifiedRef.current.set(session.docId, aligned);
      onModelContentRef.current(file.id, aligned);
      return true;
    };

    /** Bind every open file whose session is READY and model exists. */
    const attachAllOpen = (): void => {
      for (const record of recordsRef.current.values()) {
        const file = findFile(record.session.fileId);
        if (!file) {
          continue;
        }
        try {
          attachRecord(record, file);
        } catch {
          // Model churn mid-attach (rename/close races) — retried next tick.
        }
      }
    };

    const renderPeersForActiveFile = (): void => {
      const renderer = rendererRef.current;
      if (!renderer || peersRef.current.size === 0) {
        renderer?.setPeers([]);
        return;
      }
      const active = activeFileIdRef.current
        ? findFile(activeFileIdRef.current)
        : null;
      const self = clientRef.current?.currentConnectionId;
      const monaco = getSharedMonaco();
      const peers: RemotePeer[] = [];
      for (const awareness of peersRef.current.values()) {
        if (awareness.connectionId === self) {
          continue;
        }
        if (!active || awareness.fileId !== active.id) {
          continue;
        }
        peers.push(resolvePeer(awareness, monaco));
      }
      renderer.setPeers(peers);
    };

    /**
     * Resolve a peer's display position. Yjs anchors track concurrent
     * edits; the absolute line/column is the fallback when the anchor op
     * hasn't arrived yet (or the peer sent none).
     */
    const resolvePeer = (
      awareness: EditorAwarenessBroadcast,
      monaco: typeof Monaco | null,
    ): RemotePeer => {
      const fallback = {
        cursor: awareness.cursor,
        selection: awareness.selection ?? null,
      };
      const sessions = sessionsRef.current;
      const session =
        awareness.cursorRel !== undefined || awareness.selectionRel !== undefined
          ? sessions?.getByFile(awareness.projectId, awareness.fileId)
          : undefined;
      if (!session || session.currentState !== "READY" || !monaco) {
        return {
          connectionId: awareness.connectionId,
          displayName: awareness.user.displayName,
          ...fallback,
        };
      }
      const toCursor = (
        anchor: EditorRelAnchor | null | undefined,
        fb: { lineNumber: number; column: number },
     ): { lineNumber: number; column: number } => {
        if (anchor === undefined) {
          return fb;
        }
        const offset = offsetForAnchor(session.text, session.doc, anchor);
        if (offset === null) {
          return fb;
        }
        const model = getModel(monaco, findFile(awareness.fileId)?.path ?? "");
        const text = session.getText();
        const clamped = Math.max(0, Math.min(offset, text.length));
        if (!model) {
          return fb;
        }
        try {
          const pos = model.getPositionAt(clamped);
          return { lineNumber: pos.lineNumber, column: pos.column };
        } catch {
          return fb;
        }
      };
      const cursor = toCursor(awareness.cursorRel, awareness.cursor);
      let selection = fallback.selection;
      const rel = awareness.selectionRel;
      if (rel && selection) {
        const a = offsetForAnchor(session.text, session.doc, rel.anchor ?? undefined);
        const h = offsetForAnchor(session.text, session.doc, rel.head ?? undefined);
        if (a !== null && h !== null) {
          const model = getModel(monaco, findFile(awareness.fileId)?.path ?? "");
          if (model) {
            const text = session.getText();
            const pa = model.getPositionAt(Math.max(0, Math.min(a, text.length)));
            const ph = model.getPositionAt(Math.max(0, Math.min(h, text.length)));
            const ordered = pa.lineNumber < ph.lineNumber || (pa.lineNumber === ph.lineNumber && pa.column <= ph.column);
            const lo = ordered ? pa : ph;
            const hi = ordered ? ph : pa;
            selection =
              lo.lineNumber === hi.lineNumber && lo.column === hi.column
                ? null
                : {
                    startLineNumber: lo.lineNumber,
                    startColumn: lo.column,
                    endLineNumber: hi.lineNumber,
                    endColumn: hi.column,
                  };
          }
        }
      }
      return {
        connectionId: awareness.connectionId,
        displayName: awareness.user.displayName,
        cursor,
        selection,
      };
    };

    const publishAwareness = (): void => {
      const client = clientRef.current;
      const editor = getSharedEditor();
      const activeId = activeFileIdRef.current;
      if (!client || client.currentStatus !== "open" || !editor || !activeId) {
        return;
      }
      const active = findFile(activeId);
      if (!active) {
        return;
      }
      const session = sessionsRef.current?.getByFile(
        projectIdRef.current,
        active.id,
      );
      if (!session || session.currentState !== "READY") {
        return;
      }
      const position = editor.getPosition();
      if (!position) {
        return;
      }
      const selection = editor.getSelection();
      const selected =
        selection && !selection.isEmpty()
          ? {
              startLineNumber: selection.startLineNumber,
              startColumn: selection.startColumn,
              endLineNumber: selection.endLineNumber,
              endColumn: selection.endColumn,
            }
          : null;
      // Yjs anchors so the cursor tracks concurrent edits instead of
      // racing them. Computed from the attached model (binding keeps it
      // identical to the Y text); omitted when unavailable — the absolute
      // position below is the fallback.
      let cursorRel: EditorRelAnchor | null | undefined;
      let selectionRel:
        | { anchor: EditorRelAnchor | null; head: EditorRelAnchor | null }
        | null
        | undefined;
      const monaco = getSharedMonaco();
      const model = editor.getModel();
      if (monaco && model) {
        try {
          const lineCount = model.getLineCount();
          const lineNumber = Math.min(Math.max(1, position.lineNumber), lineCount);
          const column = Math.min(
            Math.max(1, position.column),
            model.getLineMaxColumn(lineNumber),
          );
          cursorRel = anchorForOffset(
            session.text,
            model.getOffsetAt(new monaco.Position(lineNumber, column)),
          );
          if (selection && !selection.isEmpty()) {
            selectionRel = {
              anchor: anchorForOffset(
                session.text,
                model.getOffsetAt(selection.getStartPosition()),
              ),
              head: anchorForOffset(
                session.text,
                model.getOffsetAt(selection.getEndPosition()),
              ),
            };
          } else {
            selectionRel = null;
          }
        } catch {
          cursorRel = undefined;
          selectionRel = undefined;
        }
      }
      client.sendRaw({
        type: "editor.awareness",
        projectId: projectIdRef.current,
        fileId: active.id,
        cursor: { lineNumber: position.lineNumber, column: position.column },
        selection: selected,
        cursorRel,
        selectionRel,
      });
    };
    const publishThrottledRef = useRef<(() => void) | null>(null);
    if (!publishThrottledRef.current) {
      publishThrottledRef.current = throttleTrailing(
        () => publishAwareness(),
        AWARENESS_THROTTLE_MS,
      );
    }

    /** Renderer + awareness for the active file (bindings stay per-file). */
    const tryAttachActive = (): void => {
      const editor = getSharedEditor();
      const monaco = getSharedMonaco();
      const activeId = activeFileIdRef.current;
      if (!editor || !monaco || !activeId) {
        return;
      }
      const active = findFile(activeId);
      if (!active) {
        rendererRef.current?.detach();
        return;
      }
      const record = recordsRef.current.get(
        editorDocId(projectIdRef.current, active.id),
      );
      if (record) {
        try {
          attachRecord(record, active);
        } catch {
          // retried on the next tick / model event
        }
      }
      const model = getModel(monaco, active.path);
      if (model) {
        rendererRef.current?.attach(editor, monaco, model);
      }
      renderPeersForActiveFile();
      publishThrottledRef.current?.();
    };

    // -- inbound routing ------------------------------------------------------
    const routeInbound = (message: InboundMessage): void => {
      const sessions = sessionsRef.current;
      if (!sessions) {
        return;
      }
      switch (message.type) {
        case "editor.joined": {
          const joined = message as EditorJoinedMessage;
          const session = sessions.get(joined.docId);
          if (!session) {
            return;
          }
          const ok = session.handleJoined(joined.update);
          if (!ok) {
            onSyncErrorRef.current?.(
              "Collaboration sync failed — editing locally only",
            );
            return;
          }
          const record = recordsRef.current.get(joined.docId);
          if (record) {
            record.joinedText = session.getText();
          }
          // Merge first, then push anything the server is missing
          // (offline typing, retained post-restart ops).
          pushDiff(session, joined.sv);
          attachAllOpen();
          tryAttachActive();
          break;
        }
        case "editor.update": {
          const update = message as EditorRemoteUpdateMessage;
          if (update.sender === clientRef.current?.currentConnectionId) {
            break;
          }
          const session = sessions.get(update.docId);
          if (!session) {
            break;
          }
          session.applyRemoteUpdate(update.update);
          // Fresh ops can resolve previously-unknown cursor anchors and
          // shift rendered positions — re-resolve.
          renderPeersForActiveFile();
          break;
        }
        case "editor.awareness": {
          const awareness = message as EditorAwarenessBroadcast;
          // Newest-wins per user per file: a reconnecting client lands on
          // a new connection id while its ghost is still being retracted,
          // and must never render twice.
          for (const [connId, existing] of [...peersRef.current]) {
            if (
              connId !== awareness.connectionId &&
              existing.fileId === awareness.fileId &&
              existing.user.userId === awareness.user.userId
            ) {
              peersRef.current.delete(connId);
            }
          }
          peersRef.current.set(awareness.connectionId, awareness);
          renderPeersForActiveFile();
          break;
        }
        case "editor.awareness.remove": {
          const remove = message as {
            type: "editor.awareness.remove";
            connectionId: string;
          };
          peersRef.current.delete(remove.connectionId);
          renderPeersForActiveFile();
          break;
        }
        case "editor.left": {
          break;
        }
        case "error": {
          const error = message as {
            type: "error";
            code?: string;
            message: string;
            requestType?: string;
          };
          if (
            error.code === "RATE_LIMITED" &&
            error.requestType === "editor.update"
          ) {
            // Self-heal: rejoin every joined doc to pull a fresh snapshot
            // and converge, then continue with live updates.
            for (const docId of [...joinedRef.current]) {
              const session = sessions.get(docId);
              joinedRef.current.delete(docId);
              if (session) {
                sendJoin(session);
              }
            }
            break;
          }
          if (
            typeof error.requestType === "string" &&
            error.requestType.startsWith("editor.")
          ) {
            onSyncErrorRef.current?.(error.message);
          }
          break;
        }
        default: {
          // File-tree / file-content hints are not editor state —
          // forward to the layout via DOM event so the existing socket
          // stays the only connection. Editor sync untouched.
          const t = (message as { type?: string }).type;
          if (
            typeof t === "string" &&
            (t.startsWith("file.tree.") || t.startsWith("file.content."))
          ) {
            try {
              window.dispatchEvent(
                new CustomEvent("vibe:file-tree", { detail: message }),
              );
            } catch {
              // layout falls back to polling
            }
          }
          break;
        }
      }
    };
    const routeInboundRef = useRef(routeInbound);
    routeInboundRef.current = routeInbound;

    // -- client lifecycle (per project) ---------------------------------------
    useEffect(() => {
      const sessions = sessionsRef.current;
      if (!sessions) {
        return;
      }
      const client = new CollabClient({
        onStatusChange: (status: CollabConnectionStatus) => {
          if (status === "open") {
            client.join(projectIdRef.current);
            // Resubscribe every open doc (fresh + reconnect alike —
            // the server re-serves snapshots idempotently).
            joinedRef.current.clear();
            for (const docId of sessions.ids()) {
              const session = sessions.get(docId);
              if (session) {
                sendJoin(session);
              }
            }
            attachAllOpen();
            tryAttachActive();
            publishThrottledRef.current?.();
          }
          if (status === "reconnecting" || status === "closed") {
            joinedRef.current.clear();
          }
        },
        onError: (message, code) => {
          if (code === "UNAUTHORIZED") {
            onSyncErrorRef.current?.(
              "Collaboration signed out — editing locally only",
            );
          } else {
            void message;
          }
        },
      });
      clientRef.current = client;
      const unsubscribe = client.addMessageListener((message) =>
        routeInboundRef.current(message),
      );
      client.connect();
      client.join(projectIdRef.current);
      // Snapshot mutable refs for the cleanup below (effect runs once per
      // project; the ref objects themselves are stable, contents change).
      const records = recordsRef.current;
      const peers = peersRef.current;
      const joined = joinedRef.current;
      const lastNotified = lastNotifiedRef.current;

      // Glue for model swaps outside this component's render cycle
      // (CodeEditor swaps models on tab switch) + a periodic sweep that
      // binds models created after their session went READY.
      const sweep = setInterval(() => {
        const editor = getSharedEditor();
        if (editor && !modelListenerDisposerRef.current) {
          modelListenerDisposerRef.current = editor.onDidChangeModel(() => {
            attachAllOpen();
            tryAttachActive();
          });
        }
        attachAllOpen();
      }, 500);

      return () => {
        clearInterval(sweep);
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        unsubscribe();
        cursorDisposerRef.current?.dispose();
        cursorDisposerRef.current = null;
        modelListenerDisposerRef.current?.dispose();
        modelListenerDisposerRef.current = null;
        for (const record of records.values()) {
          client.sendRaw({
            type: "editor.leave",
            projectId: record.session.projectId,
            fileId: record.session.fileId,
          });
        }
        rendererRef.current?.dispose();
        rendererRef.current = new RemoteCursorRenderer();
        for (const record of records.values()) {
          try {
            record.modelSub?.dispose();
          } catch {
            // already disposed
          }
          try {
            record.session.doc.off("update", record.docUpdateHandler);
          } catch {
            // already disposed
          }
          try {
            record.binding?.destroy();
          } catch {
            // already disposed
          }
        }
        records.clear();
        peers.clear();
        joined.clear();
        lastNotified.clear();
        for (const docId of sessions.ids()) {
          unregisterSession(docId);
        }
        sessions.disposeAll();
        client.disconnect();
        clientRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    // -- per-open-file sessions (join / leave / dispose) -----------------------
    const openKey = openFiles
      .map((f) => `${f.id}:${f.isFolder ? "d" : "f"}`)
      .join(",");
    useEffect(() => {
      const sessions = sessionsRef.current;
      const client = clientRef.current;
      if (!sessions) {
        return;
      }
      const keep = new Set<string>();
      for (const file of openFilesRef.current) {
        if (file.isFolder) {
          continue;
        }
        const docId = editorDocId(projectIdRef.current, file.id);
        keep.add(docId);
        if (!recordsRef.current.has(docId)) {
          const session = sessions.getOrCreate(
            projectIdRef.current,
            file.id,
            {
              onLocalUpdate: (id, update) => {
                if (clientRef.current?.currentStatus === "open") {
                  clientRef.current.sendRaw({
                    type: "editor.update",
                    docId: id,
                    update,
                  });
                }
                // Local edits shift anchored remote cursors — re-resolve.
                renderPeersForActiveFile();
              },
            },
          );
          registerSession(session);
          const docUpdateHandler = (): void => {
            renderPeersForActiveFile();
          };
          session.doc.on("update", docUpdateHandler);
          recordsRef.current.set(docId, {
            session,
            binding: null,
            bindingModel: null,
            modelSub: null,
            joinedText: null,
            docUpdateHandler,
          });
          if (client && client.currentStatus === "open") {
            session.markSyncing();
            sendJoin(session);
          } else {
            // Offline fallback: seed from DB content so local typing
            // accumulates in Y and merges on reconnect.
            session.seedLocal(file.content ?? "");
          }
        }
      }
      // Leave + dispose sessions for closed tabs.
      for (const [docId, record] of [...recordsRef.current]) {
        if (keep.has(docId)) {
          continue;
        }
        try {
          record.modelSub?.dispose();
        } catch {
          // already disposed
        }
        try {
          record.session.doc.off("update", record.docUpdateHandler);
        } catch {
          // already disposed
        }
        try {
          record.binding?.destroy();
        } catch {
          // already disposed
        }
        recordsRef.current.delete(docId);
        joinedRef.current.delete(docId);
        lastNotifiedRef.current.delete(docId);
        unregisterSession(docId);
        client?.sendRaw({
          type: "editor.leave",
          projectId: record.session.projectId,
          fileId: record.session.fileId,
        });
        // Retract any rendered peers from the closed file.
        for (const [connId, awareness] of [...peersRef.current]) {
          if (awareness.fileId === record.session.fileId) {
            peersRef.current.delete(connId);
          }
        }
        sessions.dispose(docId);
      }
      attachAllOpen();
      renderPeersForActiveFile();
      tryAttachActive();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openKey, projectId]);

    // -- active file: renderer + awareness --------------------------------------
    const activeKey = `${activeFileId ?? ""}`;
    useEffect(() => {
      renderPeersForActiveFile();
      // Retry attach briefly: CodeEditor mounts/creates the model in its
      // own effects, which may run after this effect.
      let attempts = 0;
      const retry = (): void => {
        attempts += 1;
        attachAllOpen();
        tryAttachActive();
        const editor = getSharedEditor();
        if (!editor && attempts < 20) {
          retryTimerRef.current = setTimeout(retry, 100);
        }
      };
      retry();
      publishThrottledRef.current?.();

      // Cursor/selection publishes for the active file.
      const cursorInterval = setInterval(() => {
        if (!cursorDisposerRef.current) {
          const editor = getSharedEditor();
          if (editor) {
            cursorDisposerRef.current = editor.onDidChangeCursorSelection(
              () => {
                publishThrottledRef.current?.();
              },
            );
          }
        }
      }, 500);
      return () => {
        clearInterval(cursorInterval);
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        rendererRef.current?.detach();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, projectId, openKey]);

    return null;
  },
);
