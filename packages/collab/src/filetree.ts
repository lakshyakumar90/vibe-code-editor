/**
 * File-tree operation hints (create / rename / delete / move, files + folders).
 *
 * Transport: the existing `/ws/collab` socket, project-room broadcast.
 * This is a change HINT, not a data channel: receivers re-fetch the file
 * list over REST (change-gated) which is the source of truth. File
 * *contents* keep flowing through the Yjs `editor.*` path untouched.
 *
 * Server-originated only — clients send nothing for this namespace.
 * Room membership (project members only) is the authorization boundary;
 * the REST endpoints keep enforcing per-role permissions.
 */

export const FILE_TREE_MESSAGE_TYPES = ["file.tree.changed"] as const;

export type FileTreeMessageType = (typeof FILE_TREE_MESSAGE_TYPES)[number];

/** Server → project room: tree structure changed, re-fetch the file list. */
export interface FileTreeChangedMessage {
  type: "file.tree.changed";
  projectId: string;
}

export type FileTreeServerMessage = FileTreeChangedMessage;
