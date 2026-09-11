/**
 * Phase 4A — unsaved editor state tracker (process-local).
 *
 * Distinguishes the three states the spec requires:
 *   editor state (Yjs, in-memory) vs File persisted state vs Git worktree.
 *
 * - Marked dirty when a Yjs update lands on the server (collab.editor).
 * - Marked saved when fileService.updateFile persists (save carries the
 *   converged collaborative document, so DB == editor at that instant;
 *   keystrokes arriving afterwards re-dirty correctly).
 * - Destructive Git ops (discard) consult this before touching contents.
 *
 * Approximate by design: in-flight client updates not yet received are
 * invisible here — the frontend ALSO checks local dirty state before
 * discarding. Documented in the module README.
 */
const dirty = new Map<string, Set<string>>(); // projectId -> fileIds

function key(projectId: string): string {
  return projectId;
}

export function markEditorDirty(projectId: string, fileId: string): void {
  if (!projectId || !fileId) return;
  let set = dirty.get(key(projectId));
  if (!set) {
    set = new Set();
    dirty.set(key(projectId), set);
  }
  set.add(fileId);
}

export function markEditorSaved(projectId: string, fileId: string): void {
  dirty.get(key(projectId))?.delete(fileId);
}

export function isEditorDirty(projectId: string, fileId: string): boolean {
  return dirty.get(key(projectId))?.has(fileId) ?? false;
}

/** Dirty file ids for a project (defensive copy). */
export function dirtyFileIds(projectId: string): string[] {
  return [...(dirty.get(key(projectId)) ?? [])];
}

/** For tests only. */
export function clearUnsavedTracker(): void {
  dirty.clear();
}
