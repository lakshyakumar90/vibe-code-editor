/**
 * Canonical realtime collaboration protocol (Phase 1: foundation only).
 *
 * One definition shared by `apps/api` and `apps/web` via `@repo/collab`.
 * Do NOT copy these types into app code — import from here so the
 * frontend and backend cannot drift.
 *
 * Identity rule: `userId` / `displayName` / `avatar` are ALWAYS
 * server-derived from the Better Auth session. Client messages must
 * never carry identity fields; the gateway ignores/strips them.
 *
 * Future phases (editor / AI-agent / terminal) register their own
 * `type` strings via `gateway.registerHandler(...)`. The Phase 1
 * envelope stays unchanged.
 */

/** Presence status hint. Server defaults to "online"; client may set "away". */
export type PresenceStatus = "online" | "away";

/** Server-authoritative user snapshot sent on connect. */
export interface CollabUser {
  id: string;
  displayName: string;
  avatar: string | null;
}

/** A single occupant of a project room. */
export interface Presence {
  userId: string;
  displayName: string;
  avatar: string | null;
  projectId: string;
  /** Server-generated per-WebSocket id. Multi-tab = multiple entries. */
  connectionId: string;
  status: PresenceStatus;
  /** ISO-8601 timestamp of last join/update/heartbeat. */
  lastActivity: string;
}

/** Typed server error codes. */
export const COLLAB_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "PROJECT_NOT_FOUND",
  "NOT_IN_PROJECT",
  "MALFORMED",
  "RATE_LIMITED",
] as const;

export type CollabErrorCode = (typeof COLLAB_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Client -> server (discriminated union on `type`)
// ---------------------------------------------------------------------------

export interface ProjectJoinMessage {
  type: "project.join";
  projectId: string;
}

export interface ProjectLeaveMessage {
  type: "project.leave";
  projectId: string;
}

export interface PresenceUpdateMessage {
  type: "presence.update";
  projectId: string;
  status: PresenceStatus;
}

export interface PingMessage {
  type: "ping";
  ts: number;
}

export type ClientMessage =
  | ProjectJoinMessage
  | ProjectLeaveMessage
  | PresenceUpdateMessage
  | PingMessage;

export const CLIENT_MESSAGE_TYPES = [
  "project.join",
  "project.leave",
  "presence.update",
  "ping",
] as const;

// ---------------------------------------------------------------------------
// Server -> client (discriminated union on `type`)
// ---------------------------------------------------------------------------

export interface ConnectionReadyMessage {
  type: "connection.ready";
  connectionId: string;
  user: CollabUser;
}

export interface ProjectJoinedMessage {
  type: "project.joined";
  projectId: string;
  /** Full room snapshot at join time (includes self). */
  presence: Presence[];
}

export interface ProjectLeftMessage {
  type: "project.left";
  projectId: string;
}

export interface PresenceUpdatedMessage {
  type: "presence.updated";
  presence: Presence;
}

export interface PresenceRemovedMessage {
  type: "presence.removed";
  projectId: string;
  connectionId: string;
  userId: string;
}

export interface PongMessage {
  type: "pong";
  ts: number;
}

export interface ErrorMessage {
  type: "error";
  code: CollabErrorCode;
  message: string;
  requestType?: string;
}

export type ServerMessage =
  | ConnectionReadyMessage
  | ProjectJoinedMessage
  | ProjectLeftMessage
  | PresenceUpdatedMessage
  | PresenceRemovedMessage
  | PongMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Timing constants (single source of truth for client + server)
// ---------------------------------------------------------------------------

/** Server WS heartbeat ping interval. */
export const HEARTBEAT_INTERVAL_MS = 25_000;
/** Client app-level ping interval. */
export const CLIENT_PING_INTERVAL_MS = 20_000;
/** Connections silent longer than this are swept as stale. */
export const STALE_TIMEOUT_MS = 60_000;
/** Reconnect backoff bounds for the client. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** WebSocket endpoint path on the API server. */
export const COLLAB_WS_PATH = "/ws/collab";
