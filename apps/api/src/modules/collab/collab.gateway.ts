import { randomUUID } from "node:crypto";
import {
  PresenceStore,
  STALE_TIMEOUT_MS,
  parseClientMessage,
  safeJsonParse,
} from "@repo/collab";
import type {
  ClientMessage,
  CollabPublisher,
  CollabUser,
  EditorServerMessage,
  Presence,
  PresenceStatus,
  ServerMessage,
} from "@repo/collab";
import type { ProjectAccessDeniedCode } from "./collab.access";

/**
 * Reusable realtime collaboration gateway (Phase 1: rooms + presence only).
 *
 * - One entry per WebSocket connection, keyed by server-generated `connectionId`.
 * - Project-scoped rooms backed by `PresenceStore` (ephemeral, in-memory —
 *   never persisted to Postgres).
 * - Identity is ALWAYS server-derived from the authenticated session.
 * - Future phases (editor / AI-agent / terminal) plug in via
 *   `registerHandler("editor.*", ...)` without touching this file's core.
 * - Horizontal scaling seam: pass a `remotePublisher` (e.g. Redis pub/sub
 *   later) to fan messages out; inbound cross-instance traffic re-enters
 *   via `handleRemoteMessage`. Phase 1 ships local-only.
 */

export interface GatewaySession {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

export type AccessCheck = (
  userId: string,
  projectId: string,
) => Promise<{ ok: true } | { ok: false; code: ProjectAccessDeniedCode }>;

/** Minimal socket surface the gateway needs (compatible with `ws`). */
export interface GatewaySocket {
  readyState: number;
  send(data: string): void;
  ping?(): void;
  terminate?(): void;
  close?(code?: number, reason?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...args: any[]) => void): void;
}

/** Live connection state passed to namespaced (`registerHandler`) handlers. */
export interface ConnectionState {
  id: string;
  socket: GatewaySocket;
  user: CollabUser;
  /** Last inbound activity (message or pong), epoch ms. */
  lastSeen: number;
  /** Sliding-window inbound timestamps for rate limiting. */
  hits: number[];
}

/** Public read-only view of a connection for namespaced handlers. */
export interface ConnectionInfo {
  id: string;
  user: CollabUser;
}

/** Any outbound frame: Phase 1 core + namespaced (editor.*, …) messages. */
export type OutboundMessage = ServerMessage | EditorServerMessage;

export type CustomHandler = (
  conn: ConnectionState,
  message: ClientMessage & { type: string },
) => void | Promise<void>;

const OPEN = 1;
const MAX_MESSAGES_PER_WINDOW = 120;
const RATE_WINDOW_MS = 10_000;

export function toCollabUser(session: GatewaySession): CollabUser {
  return {
    id: session.id,
    displayName: session.name ?? session.email ?? "Unknown",
    avatar: session.image ?? null,
  };
}

export class CollabGateway {
  private connections = new Map<string, ConnectionState>();
  private store = new PresenceStore();
  private handlers = new Map<string, CustomHandler>();
  private closeListeners = new Set<
    (info: ConnectionInfo) => void | Promise<void>
  >();

  constructor(
    private accessCheck: AccessCheck,
    private remotePublisher?: CollabPublisher,
    private now: () => number = Date.now,
  ) {}

  /**
   * Register a namespaced event handler for later phases, e.g.
   * `gateway.registerHandler("editor.update", handler)`.
   * Phase 1 core types are handled internally and cannot be overridden.
   */
  registerHandler(type: string, handler: CustomHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Subscribe to connection teardown (close / stale sweep). Used by
   * namespaced modules (e.g. editor awareness) to retract ephemeral
   * state. Returns an unsubscribe function.
   */
  onConnectionClosed(
    listener: (info: ConnectionInfo) => void | Promise<void>,
  ): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  connectionCount(): number {
    return this.connections.size;
  }

  /** Whether a connection currently holds a project-room membership. */
  isRoomMember(connectionId: string, projectId: string): boolean {
    return this.store.has(connectionId, projectId);
  }

  /** Server-derived identity for a live connection, if still connected. */
  getConnectionUser(connectionId: string): CollabUser | undefined {
    return this.connections.get(connectionId)?.user;
  }

  /** Direct send for namespaced handlers (respects socket readiness). */
  sendToConnection(connectionId: string, message: OutboundMessage): void {
    this.sendTo(connectionId, message);
  }

  /** Project-room broadcast for namespaced handlers (local + remote fan-out). */
  broadcastToProject(
    projectId: string,
    message: OutboundMessage,
    exceptConnectionId?: string,
  ): void {
    this.sendToProject(projectId, message, exceptConnectionId);
  }

  /** Attach a freshly authenticated socket. Sends `connection.ready`. */
  handleConnection(socket: GatewaySocket, session: GatewaySession): string {
    const id = randomUUID();
    const user = toCollabUser(session);
    const conn: ConnectionState = {
      id,
      socket,
      user,
      lastSeen: this.now(),
      hits: [],
    };
    this.connections.set(id, conn);

    socket.on("message", ((data: unknown) => {
      void this.handleRawMessage(id, data);
    }) as (...args: any[]) => void);
    socket.on("close", (() => {
      this.removeConnection(id);
    }) as (...args: any[]) => void);
    socket.on("pong", (() => {
      const current = this.connections.get(id);
      if (current) {
        current.lastSeen = this.now();
      }
    }) as (...args: any[]) => void);
    socket.on("error", (() => {
      // No-op: `close` follows and performs cleanup.
    }) as (...args: any[]) => void);

    this.sendTo(id, { type: "connection.ready", connectionId: id, user });
    return id;
  }

  /** Entry for cross-instance (Redis) fan-in. Delivers to local members only. */
  handleRemoteMessage(
    projectId: string,
    message: OutboundMessage,
    exceptConnectionId?: string,
  ): void {
    this.sendToProject(projectId, message, exceptConnectionId, {
      republish: false,
    });
  }

  /** Terminate connections silent longer than STALE_TIMEOUT_MS. */
  sweepStale(now = this.now()): string[] {
    const removed: string[] = [];
    for (const [id, conn] of this.connections) {
      if (now - conn.lastSeen > STALE_TIMEOUT_MS) {
        removed.push(id);
        try {
          conn.socket.terminate?.() ?? conn.socket.close?.(4000, "stale");
        } catch {
          // Fall through to local cleanup.
        }
        this.removeConnection(id);
      }
    }
    return removed;
  }

  // -- internals ------------------------------------------------------------

  private async handleRawMessage(
    connectionId: string,
    data: unknown,
  ): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) {
      return;
    }
    conn.lastSeen = this.now();

    if (!this.checkRateLimit(conn)) {
      this.sendTo(connectionId, {
        type: "error",
        code: "RATE_LIMITED",
        message: "Too many messages; slow down",
      });
      return;
    }

    const text = typeof data === "string" ? data : data?.toString() ?? "";
    const parsed = safeJsonParse(text);
    if (parsed === undefined) {
      this.sendTo(connectionId, {
        type: "error",
        code: "MALFORMED",
        message: "Message must be valid JSON",
      });
      return;
    }

    // Extension seam for later phases (editor / AI-agent / terminal):
    // a registered custom type bypasses the strict Phase 1 schema and
    // is validated by its own handler instead.
    if (typeof parsed === "object" && parsed !== null) {
      const rawType = (parsed as Record<string, unknown>)["type"];
      if (typeof rawType === "string") {
        const custom = this.handlers.get(rawType);
        if (custom) {
          await custom(
            conn,
            parsed as ClientMessage & { type: string },
          );
          return;
        }
      }
    }

    const result = parseClientMessage(parsed);
    if (!result.ok) {
      this.sendTo(connectionId, {
        type: "error",
        code: "MALFORMED",
        message: result.reason,
        requestType: result.requestType,
      });
      return;
    }

    await this.dispatch(conn, result.message);
  }

  private async dispatch(
    conn: ConnectionState,
    message: ClientMessage,
  ): Promise<void> {
    switch (message.type) {
      case "project.join":
        await this.joinProject(conn, message.projectId);
        return;
      case "project.leave":
        this.leaveProject(conn, message.projectId);
        return;
      case "presence.update":
        this.updatePresence(conn, message.projectId, message.status);
        return;
      case "ping":
        this.sendTo(conn.id, { type: "pong", ts: message.ts });
        return;
      default: {
        const custom = this.handlers.get(
          (message as { type: string }).type,
        );
        if (custom) {
          await custom(conn, message as ClientMessage & { type: string });
          return;
        }
        this.sendTo(conn.id, {
          type: "error",
          code: "MALFORMED",
          message: `Unknown message type: ${(message as { type: string }).type}`,
          requestType: (message as { type: string }).type,
        });
      }
    }
  }

  private async joinProject(
    conn: ConnectionState,
    projectId: string,
  ): Promise<void> {
    let access: Awaited<ReturnType<AccessCheck>>;
    try {
      access = await this.accessCheck(conn.user.id, projectId);
    } catch {
      this.sendTo(conn.id, {
        type: "error",
        code: "FORBIDDEN",
        message: "Access check failed",
        requestType: "project.join",
      });
      return;
    }

    if (!access.ok) {
      this.sendTo(conn.id, {
        type: "error",
        code: access.code === "PROJECT_NOT_FOUND" ? "PROJECT_NOT_FOUND" : "FORBIDDEN",
        message:
          access.code === "PROJECT_NOT_FOUND"
            ? "Project not found"
            : "You do not have access to this project",
        requestType: "project.join",
      });
      return;
    }

    const presence: Presence = {
      userId: conn.user.id,
      displayName: conn.user.displayName,
      avatar: conn.user.avatar,
      projectId,
      connectionId: conn.id,
      status: "online",
      lastActivity: new Date(this.now()).toISOString(),
    };
    this.store.upsert(presence);

    this.sendTo(conn.id, {
      type: "project.joined",
      projectId,
      presence: this.store.list(projectId),
    });
    this.sendToProject(
      projectId,
      { type: "presence.updated", presence },
      conn.id,
    );
  }

  private leaveProject(conn: ConnectionState, projectId: string): void {
    const removed = this.store.leave(projectId, conn.id);
    this.sendTo(conn.id, { type: "project.left", projectId });
    if (removed) {
      this.sendToProject(projectId, {
        type: "presence.removed",
        projectId,
        connectionId: conn.id,
        userId: conn.user.id,
      });
    }
  }

  private updatePresence(
    conn: ConnectionState,
    projectId: string,
    status: PresenceStatus,
  ): void {
    if (!this.store.has(conn.id, projectId)) {
      this.sendTo(conn.id, {
        type: "error",
        code: "NOT_IN_PROJECT",
        message: "Join the project before updating presence",
        requestType: "presence.update",
      });
      return;
    }
    const presence: Presence = {
      userId: conn.user.id,
      displayName: conn.user.displayName,
      avatar: conn.user.avatar,
      projectId,
      connectionId: conn.id,
      status,
      lastActivity: new Date(this.now()).toISOString(),
    };
    this.store.upsert(presence);
    this.sendToProject(projectId, { type: "presence.updated", presence });
  }

  private removeConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) {
      return;
    }
    this.connections.delete(connectionId);
    const removed = this.store.removeConnection(connectionId);
    for (const presence of removed) {
      this.sendToProject(presence.projectId, {
        type: "presence.removed",
        projectId: presence.projectId,
        connectionId,
        userId: conn.user.id,
      });
    }
    const info: ConnectionInfo = { id: connectionId, user: conn.user };
    for (const listener of [...this.closeListeners]) {
      try {
        void listener(info);
      } catch {
        // Listener failures must never break connection teardown.
      }
    }
  }

  private sendTo(connectionId: string, message: OutboundMessage): void {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.socket.readyState !== OPEN) {
      return;
    }
    try {
      conn.socket.send(JSON.stringify(message));
    } catch {
      // Send failures are cleaned up via close/sweep.
    }
  }

  private sendToProject(
    projectId: string,
    message: OutboundMessage,
    exceptConnectionId?: string,
    opts: { republish?: boolean } = {},
  ): void {
    for (const presence of this.store.list(projectId)) {
      if (presence.connectionId === exceptConnectionId) {
        continue;
      }
      this.sendTo(presence.connectionId, message);
    }
    if (opts.republish !== false) {
      try {
        this.remotePublisher?.publish(projectId, message);
      } catch {
        // Remote fan-out must never break local delivery.
      }
    }
  }

  private checkRateLimit(conn: ConnectionState): boolean {
    const windowStart = this.now() - RATE_WINDOW_MS;
    conn.hits = conn.hits.filter((t) => t > windowStart);
    if (conn.hits.length >= MAX_MESSAGES_PER_WINDOW) {
      return false;
    }
    conn.hits.push(this.now());
    return true;
  }
}
