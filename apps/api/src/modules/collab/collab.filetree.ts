import { setFileTreeBroadcaster } from "../projects/files/file.events";
import type { CollabGateway } from "./collab.gateway";

/**
 * File-tree change hints on the existing `/ws/collab` socket.
 *
 * No new socket, no client→server messages in this namespace, no payload
 * beyond the project id: the file list over REST stays the source of
 * truth and receivers refresh change-gated. File *contents* keep flowing
 * through the Yjs `editor.*` path untouched.
 *
 * Delivery is best-effort presence-style fan-out to project-room members
 * (the 15s change-gated poll is the backstop for missed hints).
 */
export function registerFileTreeHandlers(gateway: CollabGateway): void {
  // Wire persistence → project-room broadcast. Never throws into file ops.
  setFileTreeBroadcaster((projectId, message) => {
    gateway.broadcastToProject(projectId, message as unknown as never);
  });
}
