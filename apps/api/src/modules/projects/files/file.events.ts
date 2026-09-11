/**
 * File-tree change hints.
 *
 * After a successful tree mutation (create / rename / delete / move,
 * files + folders, human or AI-applied), the controller calls
 * `emitFileTreeChanged(projectId)`. The collab layer (see
 * `modules/collab/collab.filetree.ts`) injects the actual project-room
 * broadcast; until then — and if broadcasting ever fails — this is a
 * safe no-op so file persistence can never break because of realtime.
 */

export type FileTreeBroadcast = (
  projectId: string,
  message: { type: "file.tree.changed"; projectId: string },
) => void;

export type FileContentBroadcast = (
  projectId: string,
  message: { type: "file.content.changed"; projectId: string; fileIds: string[] },
) => void;

let broadcaster: FileTreeBroadcast | null = null;
let contentBroadcaster: FileContentBroadcast | null = null;

/** Injected by the collab module at server attach. Exported for tests. */
export function setFileTreeBroadcaster(fn: FileTreeBroadcast | null) {
  broadcaster = fn;
}

/** Injected by the collab module at server attach. Exported for tests. */
export function setFileContentBroadcaster(fn: FileContentBroadcast | null) {
  contentBroadcaster = fn;
}

/** Hint room members to re-fetch the file list. Never throws. */
export function emitFileTreeChanged(projectId: string): void {
  if (!projectId) return;
  try {
    broadcaster?.(projectId, { type: "file.tree.changed", projectId });
  } catch {
    // Realtime must never break file persistence.
  }
}

/**
 * Phase 4A: tell room members that specific files' persisted contents
 * changed outside their editors (git discard). Receivers re-fetch those
 * files and push them through their Yjs sessions. Never throws.
 */
export function emitFileContentChanged(projectId: string, fileIds: string[]): void {
  if (!projectId || fileIds.length === 0) return;
  try {
    contentBroadcaster?.(projectId, {
      type: "file.content.changed",
      projectId,
      fileIds: [...new Set(fileIds)],
    });
  } catch {
    // Realtime must never break file persistence.
  }
}
