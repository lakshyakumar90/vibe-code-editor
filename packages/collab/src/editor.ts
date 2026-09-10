/**
 * Phase 2 editor collaboration: document identity, sync + awareness messages.
 *
 * Transport: the existing `/ws/collab` socket. These types bypass the
 * strict Phase 1 schema and are validated by `parseEditorMessage`
 * (see `./editor-schemas.ts`); the gateway routes them to handlers
 * registered via `gateway.registerHandler("editor.*", ...)`.
 *
 * Identity rule (same as Phase 1): `userId` / `displayName` are ALWAYS
 * server-attached from the authenticated session. Clients send positions
 * only — never identity.
 */

export const EDITOR_MESSAGE_TYPES = [
  "editor.join",
  "editor.leave",
  "editor.update",
  "editor.joined",
  "editor.left",
  "editor.awareness",
  "editor.awareness.remove",
] as const;

export type EditorMessageType = (typeof EDITOR_MESSAGE_TYPES)[number];

/**
 * Deterministic shared-document identity: project + file record id.
 * Never the display name or path (both can be renamed).
 */
export function editorDocId(projectId: string, fileId: string): string {
  return `${projectId}:${fileId}`;
}

/** Split a docId back into `[projectId, fileId]`, or null when malformed. */
export function parseEditorDocId(docId: string): [string, string] | null {
  const sep = docId.indexOf(":");
  if (sep <= 0 || sep === docId.length - 1) {
    return null;
  }
  return [docId.slice(0, sep), docId.slice(sep + 1)];
}

export interface EditorCursor {
  lineNumber: number;
  column: number;
}

export interface EditorSelectionRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * Yjs-anchored position: the item id + associativity from
 * `Y.createRelativePositionFromTypeIndex`. Unlike absolute line/column,
 * this survives concurrent edits — the receiver resolves it against its
 * own doc state, so a cursor never renders "one word behind" just because
 * a text update is still in flight. `null` anchors to doc start.
 */
export interface EditorRelAnchor {
  client: number;
  clock: number;
  assoc: number;
  tname?: string;
}

export interface EditorRelSelection {
  anchor?: EditorRelAnchor | null;
  head?: EditorRelAnchor | null;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface EditorJoinMessage {
  type: "editor.join";
  projectId: string;
  fileId: string;
  /**
   * Base64 Yjs state vector, sent when the local doc already holds
   * content (reconnect / offline typing). Lets the server reply with a
   * diff instead of full state and detect client-ahead (restart) cases.
   */
  sv?: string;
}

export interface EditorLeaveMessage {
  type: "editor.leave";
  projectId: string;
  fileId: string;
}

export interface EditorUpdateMessage {
  type: "editor.update";
  /** `editorDocId(projectId, fileId)`. */
  docId: string;
  /** Base64-encoded Yjs document update. */
  update: string;
}

export interface EditorAwarenessMessage {
  type: "editor.awareness";
  projectId: string;
  fileId: string;
  cursor: EditorCursor;
  selection?: EditorSelectionRange | null;
  /**
   * Yjs-anchored cursor/selection (preferred rendering source).
   * Absolute `cursor`/`selection` remain required as the fallback for
   * peers whose doc cannot resolve the anchor yet.
   */
  cursorRel?: EditorRelAnchor | null;
  selectionRel?: EditorRelSelection | null;
}

export type EditorClientMessage =
  | EditorJoinMessage
  | EditorLeaveMessage
  | EditorUpdateMessage
  | EditorAwarenessMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface EditorJoinedMessage {
  type: "editor.joined";
  docId: string;
  /**
   * Base64 state diff when the server holds document state (late join /
   * reconnect / DB reseed). Absent when the server doc is empty — the
   * client then pushes its own diff, if any.
   */
  update?: string;
  /** Base64 server state vector — the client diffs against this. */
  sv: string;
}

export interface EditorLeftMessage {
  type: "editor.left";
  docId: string;
}

export interface EditorRemoteUpdateMessage {
  type: "editor.update";
  docId: string;
  update: string;
  /** Server-attached sender connection id (echo suppression). */
  sender: string;
}

export interface EditorAwarenessBroadcast {
  type: "editor.awareness";
  projectId: string;
  fileId: string;
  cursor: EditorCursor;
  selection?: EditorSelectionRange | null;
  cursorRel?: EditorRelAnchor | null;
  selectionRel?: EditorRelSelection | null;
  /** Server-attached identity — never client-provided. */
  user: { userId: string; displayName: string };
  connectionId: string;
}

export interface EditorAwarenessRemove {
  type: "editor.awareness.remove";
  projectId: string;
  fileId: string;
  connectionId: string;
}

export type EditorServerMessage =
  | EditorJoinedMessage
  | EditorLeftMessage
  | EditorRemoteUpdateMessage
  | EditorAwarenessBroadcast
  | EditorAwarenessRemove;

// ---------------------------------------------------------------------------
// Sync state machine (client doc sessions)
// ---------------------------------------------------------------------------

export type EditorDocState =
  | "UNINITIALIZED"
  | "LOCAL_SEEDING"
  | "SYNCING"
  | "READY";

/** Outbound Yjs updates are mirrored here while the socket is down. */
export const EDITOR_OUTBOX_MAX_BYTES = 5 * 1024 * 1024;

/** Largest single inbound update the server will apply (DoS bound). */
export const EDITOR_MAX_UPDATE_BYTES = 1024 * 1024;

/** Largest server-held document snapshot served on join. */
export const EDITOR_MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/** Upper bound on server-held collaborative documents (LRU-evicted). */
export const EDITOR_MAX_SERVER_DOCS = 1000;

/** Client awareness publish throttle. */
export const AWARENESS_THROTTLE_MS = 250;

/** Largest state vector accepted on join (vectors are tiny; bound abuse). */
export const EDITOR_MAX_SV_BYTES = 64 * 1024;
