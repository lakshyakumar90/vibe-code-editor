import * as Y from "yjs";
import { prisma } from "@repo/db";
import {
  EDITOR_MAX_SERVER_DOCS,
  EDITOR_MAX_SNAPSHOT_BYTES,
  EDITOR_MAX_SV_BYTES,
  EDITOR_MAX_UPDATE_BYTES,
  base64ByteLength,
  decodeUpdate,
  editorDocId,
  encodeUpdate,
  parseEditorDocId,
  parseEditorMessage,
} from "@repo/collab";
import type {
  EditorAwarenessMessage,
  EditorCursor,
  EditorJoinMessage,
  EditorLeaveMessage,
  EditorSelectionRange,
  EditorUpdateMessage,
} from "@repo/collab";
import type {
  AccessCheck,
  CollabGateway,
  ConnectionState,
} from "./collab.gateway";

interface AwarenessEntry {
  projectId: string;
  fileId: string;
  cursor: EditorCursor;
  selection?: EditorSelectionRange | null;
  userId: string;
}

export type SeedResult =
  | { ok: true; content: string | null }
  | { ok: false; code: "PROJECT_NOT_FOUND" | "FORBIDDEN" };

/**
 * Loads persisted file content for first-touch seeding. Default reads
 * Postgres; tests inject an in-memory double.
 */
export type DocSeeder = (
  projectId: string,
  fileId: string,
) => Promise<SeedResult>;

const prismaSeeder: DocSeeder = async (projectId, fileId) => {
  let row: {
    projectId: string;
    isFolder: boolean;
    content: string | null;
  } | null;
  try {
    row = await prisma.file.findUnique({
      where: { id: fileId },
      select: { projectId: true, isFolder: true, content: true },
    });
  } catch {
    return { ok: false, code: "PROJECT_NOT_FOUND" };
  }
  if (!row) {
    return { ok: false, code: "PROJECT_NOT_FOUND" };
  }
  if (row.projectId !== projectId || row.isFolder) {
    return { ok: false, code: "FORBIDDEN" };
  }
  return { ok: true, content: row.content };
};

/**
 * Phase 2 server document authority (ephemeral — never Postgres).
 *
 * - One in-memory `Y.Doc` per `docId` (`<projectId>:<fileId>`), LRU-bounded.
 * - Applies each sender-validated update, then relays it to the rest of
 *   the project room. The server doc lets late joiners / reconnects catch
 *   up via `editor.joined { update: <full state> }`.
 * - Awareness (cursor/selection) is relayed with server-attached identity
 *   and retracted on leave / file-switch / disconnect.
 * - Every editor message requires current project-room membership AND a
 *   fresh project access check (membership may have been revoked since
 *   `project.join`).
 */
export class EditorSyncService {
  private docs = new Map<string, Y.Doc>();
  private awareness = new Map<string, AwarenessEntry>();
  /** In-flight DB seeds — concurrent joiners await instead of double-seeding. */
  private pendingSeeds = new Map<string, Promise<boolean>>();
  /** Denial reason left behind by a failed seed (avoids a second lookup). */
  private seedDenials = new Map<string, "PROJECT_NOT_FOUND" | "FORBIDDEN">();

  constructor(
    private gateway: CollabGateway,
    private accessCheck: AccessCheck,
    private seed: DocSeeder = prismaSeeder,
  ) {
    gateway.registerHandler("editor.join", (conn, raw) =>
      this.handleJoin(conn, raw),
    );
    gateway.registerHandler("editor.leave", (conn, raw) =>
      this.handleLeave(conn, raw),
    );
    gateway.registerHandler("editor.update", (conn, raw) =>
      this.handleUpdate(conn, raw),
    );
    gateway.registerHandler("editor.awareness", (conn, raw) =>
      this.handleAwareness(conn, raw),
    );
    gateway.onConnectionClosed((info) => {
      this.retractAwareness(info.id);
    });
  }

  /** Number of server-held docs (observability / tests). */
  docCount(): number {
    return this.docs.size;
  }

  // -- join / leave ----------------------------------------------------------

  private async handleJoin(
    conn: ConnectionState,
    raw: unknown,
  ): Promise<void> {
    const parsed = parseEditorMessage(raw);
    if (!parsed.ok || parsed.message.type !== "editor.join") {
      this.fail(conn.id, "editor.join", "MALFORMED", parsed.ok ? "Unexpected message type" : parsed.reason);
      return;
    }
    const message: EditorJoinMessage = parsed.message;
    if (message.sv && base64ByteLength(message.sv) > EDITOR_MAX_SV_BYTES) {
      this.fail(conn.id, "editor.join", "MALFORMED", "State vector too large");
      return;
    }
    const granted = await this.authorize(conn, message.projectId, "editor.join");
    if (!granted) {
      return;
    }

    const docId = editorDocId(message.projectId, message.fileId);
    const seeded = await this.ensureSeeded(
      conn.id,
      "editor.join",
      docId,
      message.projectId,
      message.fileId,
    );
    if (!seeded) {
      return;
    }
    const doc = this.docs.get(docId);
    if (!doc) {
      this.fail(conn.id, "editor.join", "PROJECT_NOT_FOUND", "File not found");
      return;
    }
    // LRU touch.
    this.docs.delete(docId);
    this.docs.set(docId, doc);

    const state = Y.encodeStateAsUpdate(doc);
    const sv = encodeUpdate(Y.encodeStateVector(doc));
    // A fresh Y.Doc encodes to a 2-byte header — effectively empty.
    if (state.length <= 2) {
      this.gateway.sendToConnection(conn.id, { type: "editor.joined", docId, sv });
      return;
    }
    if (state.length > EDITOR_MAX_SNAPSHOT_BYTES) {
      this.fail(
        conn.id,
        "editor.join",
        "MALFORMED",
        "Document snapshot too large to serve",
      );
      return;
    }
    this.gateway.sendToConnection(conn.id, {
      type: "editor.joined",
      docId,
      update: encodeUpdate(state),
      sv,
    });
  }

  private async handleLeave(
    conn: ConnectionState,
    raw: unknown,
  ): Promise<void> {
    const parsed = parseEditorMessage(raw);
    if (!parsed.ok || parsed.message.type !== "editor.leave") {
      this.fail(conn.id, "editor.leave", "MALFORMED", parsed.ok ? "Unexpected message type" : parsed.reason);
      return;
    }
    const message: EditorLeaveMessage = parsed.message;
    const docId = editorDocId(message.projectId, message.fileId);
    this.clearAwarenessForDoc(conn.id, message.projectId, message.fileId);
    this.gateway.sendToConnection(conn.id, { type: "editor.left", docId });
  }

  // -- document updates --------------------------------------------------------

  private async handleUpdate(
    conn: ConnectionState,
    raw: unknown,
  ): Promise<void> {
    const parsed = parseEditorMessage(raw);
    if (!parsed.ok || parsed.message.type !== "editor.update") {
      this.fail(conn.id, "editor.update", "MALFORMED", parsed.ok ? "Unexpected message type" : parsed.reason);
      return;
    }
    const message: EditorUpdateMessage = parsed.message;
    const parts = parseEditorDocId(message.docId);
    if (!parts) {
      this.fail(conn.id, "editor.update", "MALFORMED", "Invalid docId");
      return;
    }
    const [projectId, fileId] = parts;
    const granted = await this.authorize(conn, projectId, "editor.update");
    if (!granted) {
      return;
    }
    if (base64ByteLength(message.update) > EDITOR_MAX_UPDATE_BYTES) {
      this.fail(conn.id, "editor.update", "MALFORMED", "Update too large");
      return;
    }
    const bytes = decodeUpdate(message.update);
    if (!bytes) {
      this.fail(conn.id, "editor.update", "MALFORMED", "Update is not valid base64");
      return;
    }

    // Seed first so an update can never orphan a doc from its DB base.
    const seeded = await this.ensureSeeded(
      conn.id,
      "editor.update",
      message.docId,
      projectId,
      fileId,
    );
    if (!seeded) {
      return;
    }
    const doc = this.getOrCreateDoc(message.docId);
    try {
      Y.applyUpdate(doc, bytes);
    } catch {
      this.fail(conn.id, "editor.update", "MALFORMED", "Update could not be applied");
      return;
    }
    this.gateway.broadcastToProject(
      projectId,
      {
        type: "editor.update",
        docId: message.docId,
        update: message.update,
        sender: conn.id,
      },
      conn.id,
    );
  }

  // -- awareness -----------------------------------------------------------------

  private async handleAwareness(
    conn: ConnectionState,
    raw: unknown,
  ): Promise<void> {
    const parsed = parseEditorMessage(raw);
    if (!parsed.ok || parsed.message.type !== "editor.awareness") {
      this.fail(conn.id, "editor.awareness", "MALFORMED", parsed.ok ? "Unexpected message type" : parsed.reason);
      return;
    }
    const message: EditorAwarenessMessage = parsed.message;
    const granted = await this.authorize(
      conn,
      message.projectId,
      "editor.awareness",
    );
    if (!granted) {
      return;
    }

    const previous = this.awareness.get(conn.id);
    if (
      previous &&
      (previous.projectId !== message.projectId ||
        previous.fileId !== message.fileId)
    ) {
      // File switch: retract the stale file entry so peers never render
      // this cursor on the wrong file.
      this.gateway.broadcastToProject(previous.projectId, {
        type: "editor.awareness.remove",
        projectId: previous.projectId,
        fileId: previous.fileId,
        connectionId: conn.id,
      });
    }

    // Same-user dedupe: one visible cursor per user per file. This kills
    // ghosts from dead sockets (reconnects land on a new connection id
    // while the old socket's close is still in flight) so a user never
    // renders at two places at once.
    for (const [otherId, entry] of [...this.awareness]) {
      if (
        otherId !== conn.id &&
        entry.projectId === message.projectId &&
        entry.fileId === message.fileId &&
        entry.userId === conn.user.id
      ) {
        this.awareness.delete(otherId);
        this.gateway.broadcastToProject(entry.projectId, {
          type: "editor.awareness.remove",
          projectId: entry.projectId,
          fileId: entry.fileId,
          connectionId: otherId,
        });
      }
    }

    this.awareness.set(conn.id, {
      projectId: message.projectId,
      fileId: message.fileId,
      cursor: message.cursor,
      selection: message.selection ?? null,
      userId: conn.user.id,
    });

    this.gateway.broadcastToProject(
      message.projectId,
      {
        type: "editor.awareness",
        projectId: message.projectId,
        fileId: message.fileId,
        cursor: message.cursor,
        selection: message.selection ?? null,
        // Passed through untouched: `undefined` means "no anchor, use the
        // absolute fallback", while `null` is a real end-of-doc anchor.
        cursorRel: message.cursorRel,
        selectionRel: message.selectionRel,
        user: {
          userId: conn.user.id,
          displayName: conn.user.displayName,
        },
        connectionId: conn.id,
      },
      conn.id,
    );
  }

  // -- internals -------------------------------------------------------------------

  /**
   * Room membership (fast path) + fresh access check (revocation-safe).
   * Sends the matching `error` event and returns false on denial.
   */
  private async authorize(
    conn: ConnectionState,
    projectId: string,
    requestType: string,
  ): Promise<boolean> {
    if (!this.gateway.isRoomMember(conn.id, projectId)) {
      this.fail(
        conn.id,
        requestType,
        "NOT_IN_PROJECT",
        "Join the project before collaborating",
      );
      return false;
    }
    let access: Awaited<ReturnType<AccessCheck>>;
    try {
      access = await this.accessCheck(conn.user.id, projectId);
    } catch {
      this.fail(conn.id, requestType, "FORBIDDEN", "Access check failed");
      return false;
    }
    if (!access.ok) {
      this.fail(
        conn.id,
        requestType,
        access.code === "PROJECT_NOT_FOUND" ? "PROJECT_NOT_FOUND" : "FORBIDDEN",
        access.code === "PROJECT_NOT_FOUND"
          ? "Project not found"
          : "You do not have access to this project",
      );
      return false;
    }
    return true;
  }

  /**
   * Single-seeder bootstrap: the FIRST join/update for a doc loads the
   * file's persisted content from Postgres into the server Y.Doc, so
   * clients never seed and concurrent joiners cannot double-seed.
   * Concurrent callers await the in-flight seed. Returns false (after
   * sending the matching `error`) when the file is gone or foreign.
   */
  private async ensureSeeded(
    connectionId: string,
    requestType: string,
    docId: string,
    projectId: string,
    fileId: string,
  ): Promise<boolean> {
    if (this.docs.has(docId)) {
      return true;
    }
    let pending = this.pendingSeeds.get(docId);
    if (!pending) {
      pending = this.seedFromDb(docId, projectId, fileId);
      this.pendingSeeds.set(docId, pending);
    }
    let ok: boolean;
    try {
      ok = await pending;
    } catch {
      ok = false;
    } finally {
      if (this.pendingSeeds.get(docId) === pending) {
        this.pendingSeeds.delete(docId);
      }
    }
    if (!ok) {
      const code = this.seedDenials.get(docId) ?? "PROJECT_NOT_FOUND";
      this.seedDenials.delete(docId);
      if (code === "PROJECT_NOT_FOUND") {
        this.fail(connectionId, requestType, "PROJECT_NOT_FOUND", "File not found");
      } else {
        // Exists but belongs elsewhere (or is a folder) — same denial as
        // access checks, without leaking which case it is.
        this.fail(
          connectionId,
          requestType,
          "FORBIDDEN",
          "You do not have access to this project",
        );
      }
      return false;
    }
    return true;
  }

  /** Load persisted content into a fresh server doc. False when unseedable. */
  private async seedFromDb(
    docId: string,
    projectId: string,
    fileId: string,
  ): Promise<boolean> {
    let result: SeedResult;
    try {
      result = await this.seed(projectId, fileId);
    } catch {
      return false;
    }
    if (!result.ok) {
      // Stash the denial reason for the caller without an extra lookup.
      this.seedDenials.set(docId, result.code);
      return false;
    }
    // Another concurrent path may have initialized while we awaited.
    if (this.docs.has(docId)) {
      return true;
    }
    const doc = this.getOrCreateDoc(docId);
    if (result.content) {
      try {
        doc.transact(() => {
          doc.getText("content").insert(0, result.content as string);
        });
      } catch {
        return false;
      }
    }
    return true;
  }

  private getOrCreateDoc(docId: string): Y.Doc {
    const existing = this.docs.get(docId);
    if (existing) {
      // LRU touch.
      this.docs.delete(docId);
      this.docs.set(docId, existing);
      return existing;
    }
    const doc = new Y.Doc();
    this.docs.set(docId, doc);
    while (this.docs.size > EDITOR_MAX_SERVER_DOCS) {
      const oldest = this.docs.keys().next();
      if (oldest.done) {
        break;
      }
      const evicted = this.docs.get(oldest.value);
      this.docs.delete(oldest.value);
      try {
        evicted?.destroy();
      } catch {
        // best-effort
      }
    }
    return doc;
  }

  private clearAwarenessForDoc(
    connectionId: string,
    projectId: string,
    fileId: string,
  ): void {
    const entry = this.awareness.get(connectionId);
    if (
      entry &&
      entry.projectId === projectId &&
      entry.fileId === fileId
    ) {
      this.awareness.delete(connectionId);
      this.gateway.broadcastToProject(projectId, {
        type: "editor.awareness.remove",
        projectId,
        fileId,
        connectionId,
      });
    }
  }

  private retractAwareness(connectionId: string): void {
    const entry = this.awareness.get(connectionId);
    if (!entry) {
      return;
    }
    this.awareness.delete(connectionId);
    this.gateway.broadcastToProject(entry.projectId, {
      type: "editor.awareness.remove",
      projectId: entry.projectId,
      fileId: entry.fileId,
      connectionId,
    });
  }

  private fail(
    connectionId: string,
    requestType: string,
    code: "MALFORMED" | "FORBIDDEN" | "PROJECT_NOT_FOUND" | "NOT_IN_PROJECT",
    message: string,
  ): void {
    this.gateway.sendToConnection(connectionId, {
      type: "error",
      code,
      message,
      requestType,
    });
  }
}

/** Attach Phase 2 editor handlers to a gateway. Returns the service. */
export function registerEditorHandlers(
  gateway: CollabGateway,
  accessCheck: AccessCheck,
  seed?: DocSeeder,
): EditorSyncService {
  return new EditorSyncService(gateway, accessCheck, seed);
}
