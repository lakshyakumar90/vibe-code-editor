import * as Y from "yjs";
import {
  decodeUpdate,
  editorDocId,
  encodeUpdate,
} from "@repo/collab";
import type { EditorDocState } from "@repo/collab";

/**
 * Origin tag for updates applied from the network. The doc-level
 * `update` listener skips this origin — defense-in-depth alongside the
 * y-monaco mutex so remote updates can never echo back to the server.
 */
export const REMOTE_ORIGIN = "collab-remote";

/** Origin tag for the initial local seed (never broadcast standalone). */
export const SEED_ORIGIN = "collab-seed";

/** A diff of this size or less carries no operations (header only). */
const TRIVIAL_DIFF_BYTES = 2;

export interface DocSessionEvents {
  /** A local Yjs update ready to send (`editor.update`). */
  onLocalUpdate?: (docId: string, updateBase64: string) => void;
  onStateChange?: (docId: string, state: EditorDocState) => void;
}

/**
 * One collaborative document: `Y.Doc` + `Y.Text("content")` lifecycle and
 * the `UNINITIALIZED → LOCAL_SEEDING → SYNCING → READY` state machine.
 *
 * No Monaco, no DOM — safe to unit test in Node.
 *
 * Ownership:
 * - While READY, the Y.Text IS the live document; the Monaco model
 *   mirrors it (see `monaco-binding.ts`).
 * - The doc itself retains every local op, so reconnect resync is a
 *   state-vector diff against the server — no separate outbox, no
 *   silently discarded local work.
 * - Persistence stays with the existing save API (`PUT …/files/:fileId`);
 *   keystrokes are never written to Postgres here.
 */
export class DocSession {
  readonly docId: string;
  readonly projectId: string;
  readonly fileId: string;
  readonly doc: Y.Doc;
  readonly text: Y.Text;

  private state: EditorDocState = "UNINITIALIZED";
  private events: DocSessionEvents;
  private updateListener: (update: Uint8Array, origin: unknown) => void;

  constructor(projectId: string, fileId: string, events: DocSessionEvents = {}) {
    this.projectId = projectId;
    this.fileId = fileId;
    this.docId = editorDocId(projectId, fileId);
    this.events = events;
    this.doc = new Y.Doc();
    this.text = this.doc.getText("content");
    this.updateListener = (update, origin) => {
      // Remote-applied and seed transactions never go back on the wire.
      if (origin === REMOTE_ORIGIN || origin === SEED_ORIGIN) {
        return;
      }
      if (this.state === "READY") {
        this.events.onLocalUpdate?.(this.docId, encodeUpdate(update));
      }
      // Pre-READY local ops stay in the doc and are replayed as a
      // state-vector diff on join — no separate outbox needed.
    };
    this.doc.on("update", this.updateListener);
  }

  get currentState(): EditorDocState {
    return this.state;
  }

  getText(): string {
    return this.text.toString();
  }

  get isEmpty(): boolean {
    return this.text.length === 0;
  }

  /** Base64 state vector for `editor.join` (omitted when doc is empty). */
  getStateVectorBase64(): string | undefined {
    if (this.text.length === 0 && this.doc.store.clients.size === 0) {
      return undefined;
    }
    return encodeUpdate(Y.encodeStateVector(this.doc));
  }

  /**
   * Seed from the DB-loaded file content. Only writes when the local
   * text is still empty (fresh session) — retained docs (reconnect)
   * keep their state so nothing is clobbered. Used as an offline
   * fallback; when the socket is up the server snapshot is authoritative.
   */
  seedLocal(content: string): void {
    if (this.state !== "UNINITIALIZED") {
      return;
    }
    this.setState("LOCAL_SEEDING");
    if (this.text.length === 0 && content.length > 0) {
      this.doc.transact(() => {
        this.text.insert(0, content);
      }, SEED_ORIGIN);
    }
    this.setState("SYNCING");
  }

  /** Mark the session as awaiting the server snapshot (socket is up). */
  markSyncing(): void {
    if (this.state === "UNINITIALIZED" || this.state === "LOCAL_SEEDING") {
      this.setState("SYNCING");
    }
  }

  /**
   * Handle `editor.joined`: merge the server snapshot and go READY.
   * Returns false when the snapshot is corrupt (caller keeps the editor
   * read-only instead of editing a diverged doc). After folding any
   * pre-join model content, the caller pushes `diffAgainst(serverSv)`.
   */
  handleJoined(serverUpdateBase64?: string): boolean {
    if (serverUpdateBase64) {
      const bytes = decodeUpdate(serverUpdateBase64);
      if (bytes) {
        try {
          Y.applyUpdate(this.doc, bytes, REMOTE_ORIGIN);
        } catch {
          // Corrupt snapshot: stay SYNCING so the UI keeps the editor
          // read-only instead of editing a diverged doc.
          return false;
        }
      }
    }
    this.setState("READY");
    return true;
  }

  /**
   * Diff of local ops unknown to `serverSvBase64` (base64). Null when
   * converged — or when no vector was given and the doc is empty.
   * When no vector was given and the doc holds content (genuinely fresh
   * doc), returns the full state.
   */
  diffAgainst(serverSvBase64?: string): string | null {
    let diff: Uint8Array;
    if (serverSvBase64) {
      const sv = decodeUpdate(serverSvBase64);
      if (!sv) {
        return null;
      }
      try {
        diff = Y.encodeStateAsUpdate(this.doc, sv);
      } catch {
        return null;
      }
    } else {
      if (this.text.length === 0) {
        return null;
      }
      diff = Y.encodeStateAsUpdate(this.doc);
    }
    if (diff.length <= TRIVIAL_DIFF_BYTES) {
      return null;
    }
    return encodeUpdate(diff);
  }

  /** Apply an inbound `editor.update` payload. Returns false when corrupt. */
  applyRemoteUpdate(updateBase64: string): boolean {
    const bytes = decodeUpdate(updateBase64);
    if (!bytes) {
      return false;
    }
    try {
      Y.applyUpdate(this.doc, bytes, REMOTE_ORIGIN);
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Whole-content replacement through the Yjs path (AI changeset apply,
   * Reset-to-saved, pre-join model fold-in). Peers converge on the new
   * content via the normal update flow instead of a model `setValue`
   * bypass.
   */
  applyExternalContent(content: string, origin: unknown = "external"): void {
    const current = this.text.toString();
    if (current === content) {
      return;
    }
    this.doc.transact(() => {
      this.text.delete(0, current.length);
      if (content.length > 0) {
        this.text.insert(0, content);
      }
    }, origin);
  }

  destroy(): void {
    this.doc.off("update", this.updateListener);
    try {
      this.doc.destroy();
    } catch {
      // best-effort
    }
  }

  // -- internals ------------------------------------------------------------

  private setState(state: EditorDocState): void {
    this.state = state;
    this.events.onStateChange?.(this.docId, state);
  }
}

/**
 * One session per docId per tab. Duplicate `editor.join` for the same
 * file reuses the session — never two `Y.Doc`s for one file in a tab.
 */
export class DocSessionManager {
  private sessions = new Map<string, DocSession>();

  getOrCreate(
    projectId: string,
    fileId: string,
    events: DocSessionEvents = {},
  ): DocSession {
    const docId = editorDocId(projectId, fileId);
    const existing = this.sessions.get(docId);
    if (existing) {
      return existing;
    }
    const session = new DocSession(projectId, fileId, events);
    this.sessions.set(docId, session);
    return session;
  }

  get(docId: string): DocSession | undefined {
    return this.sessions.get(docId);
  }

  getByFile(projectId: string, fileId: string): DocSession | undefined {
    return this.sessions.get(editorDocId(projectId, fileId));
  }

  has(docId: string): boolean {
    return this.sessions.has(docId);
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /** Leave + destroy one document session. Returns false when absent. */
  dispose(docId: string): boolean {
    const session = this.sessions.get(docId);
    if (!session) {
      return false;
    }
    this.sessions.delete(docId);
    session.destroy();
    return true;
  }

  /** Retain only the given docIds; dispose everything else. */
  retain(keep: Set<string>): string[] {
    const disposed: string[] = [];
    for (const docId of [...this.sessions.keys()]) {
      if (!keep.has(docId)) {
        this.dispose(docId);
        disposed.push(docId);
      }
    }
    return disposed;
  }

  disposeAll(): void {
    for (const docId of [...this.sessions.keys()]) {
      this.dispose(docId);
    }
  }

  size(): number {
    return this.sessions.size;
  }
}
