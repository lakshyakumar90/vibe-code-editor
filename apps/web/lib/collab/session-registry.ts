import { editorDocId } from "@repo/collab";
import type { DocSession } from "./doc-session";

/**
 * Module-level registry of live Yjs sessions, populated by
 * `CollabBridge` and consulted by `CodeEditor`.
 *
 * Why: once a session is READY, the Yjs binding owns the Monaco model.
 * React props (`value` from `editedContents`) can lag the live document
 * by a render — driving `model.setValue` from them would clobber fresh
 * (often remote) content, yank the cursor, and broadcast delete-all /
 * insert-all storms. The registry lets the editor skip all prop-driven
 * model writes for managed files. Mirrors the shared-singleton pattern
 * in `lib/language/model-manager.ts`.
 */
const sessions = new Map<string, DocSession>();

export function registerSession(session: DocSession): void {
  sessions.set(session.docId, session);
}

export function unregisterSession(docId: string): void {
  sessions.delete(docId);
}

/** True when a READY session owns this file's model content. */
export function isSessionReady(projectId: string, fileId: string): boolean {
  const session = sessions.get(editorDocId(projectId, fileId));
  return !!session && session.currentState === "READY";
}

/** Live Yjs text, or undefined when no READY session exists. */
export function getSessionText(
  projectId: string,
  fileId: string,
): string | undefined {
  const session = sessions.get(editorDocId(projectId, fileId));
  if (!session || session.currentState !== "READY") {
    return undefined;
  }
  return session.getText();
}
