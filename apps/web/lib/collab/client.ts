import {
  CLIENT_PING_INTERVAL_MS,
  COLLAB_WS_PATH,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "@repo/collab";
import type {
  ClientMessage,
  CollabUser,
  EditorServerMessage,
  FileTreeServerMessage,
  Presence,
  PresenceStatus,
  ServerMessage,
} from "@repo/collab";

export type CollabConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

/** Any inbound server frame (Phase 1 + namespaced editor / file-tree messages). */
export type InboundMessage =
  | ServerMessage
  | EditorServerMessage
  | FileTreeServerMessage;

export type MessageListener = (message: InboundMessage) => void;

export interface CollabClientEvents {
  onStatusChange?: (status: CollabConnectionStatus) => void;
  onPresence?: (presence: Presence[]) => void;
  onPresenceUpdated?: (presence: Presence) => void;
  onPresenceRemoved?: (info: {
    projectId: string;
    connectionId: string;
    userId: string;
  }) => void;
  onError?: (message: string, code?: string) => void;
}

/**
 * Convert the REST base URL into a WS(S) URL, e.g.
 * `http://localhost:5000` -> `ws://localhost:5000`.
 * Pure helper — exported for testing.
 */
export function httpToWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return `wss://${httpUrl.slice("https://".length)}`;
  }
  if (httpUrl.startsWith("http://")) {
    return `ws://${httpUrl.slice("http://".length)}`;
  }
  return httpUrl;
}

/** Exponential backoff with jitter. Pure helper — exported for testing. */
export function computeBackoff(attempt: number): number {
  const exp = RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5);
  return Math.min(exp + Math.random() * 250, RECONNECT_MAX_MS);
}

export function resolveCollabUrl(baseUrl?: string): string {
  const base =
    baseUrl ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:5000";
  return `${httpToWsUrl(base).replace(/\/$/, "")}${COLLAB_WS_PATH}`;
}

/**
 * Reusable collaboration client (Phase 1 rooms + presence, Phase 2 editor).
 *
 * - One instance = one authenticated connection (Better Auth cookies
 *   are sent automatically by the browser WebSocket handshake).
 * - Maintains the joined-project set and re-sends `project.join`
 *   after every reconnect.
 * - Exponential-backoff reconnect; 401 responses stop retrying
 *   (re-auth is required instead of a hot loop).
 * - Namespaced frames (`editor.*`, later `ai.*`/`terminal.*`) are
 *   forwarded to `addMessageListener` subscribers; outbound frames go
 *   through `sendRaw`. Durability (re-subscribe, update outbox) is the
 *   owning module's job — see `collab-bridge.tsx`.
 */
export class CollabClient {
  private ws: WebSocket | null = null;
  private joined = new Set<string>();
  private presenceByProject = new Map<string, Map<string, Presence>>();
  private status: CollabConnectionStatus = "idle";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;
  private connectionId: string | null = null;
  private selfUser: CollabUser | null = null;
  private messageListeners = new Set<MessageListener>();

  constructor(
    private events: CollabClientEvents = {},
    private url: string = resolveCollabUrl(),
  ) {}

  get currentStatus(): CollabConnectionStatus {
    return this.status;
  }

  get currentConnectionId(): string | null {
    return this.connectionId;
  }

  /** Server-derived identity for this connection (null until ready). */
  get currentUser(): CollabUser | null {
    return this.selfUser;
  }

  get joinedProjects(): string[] {
    return [...this.joined];
  }

  /**
   * Subscribe to inbound frames not handled by the Phase 1 core
   * (e.g. `editor.*`). Returns an unsubscribe function.
   */
  addMessageListener(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  connect(): void {
    if (
      this.status === "connecting" ||
      this.status === "open" ||
      this.status === "reconnecting"
    ) {
      return;
    }
    this.closedByUser = false;
    this.openSocket();
  }

  disconnect(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.ws?.close(1000, "client disconnect");
    this.ws = null;
    this.setStatus("closed");
  }

  join(projectId: string): void {
    this.joined.add(projectId);
    this.send({ type: "project.join", projectId });
  }

  leave(projectId: string): void {
    this.joined.delete(projectId);
    this.presenceByProject.delete(projectId);
    this.send({ type: "project.leave", projectId });
    this.emitPresence(projectId);
  }

  setPresenceStatus(projectId: string, status: PresenceStatus): void {
    this.send({ type: "presence.update", projectId, status });
  }

  presenceFor(projectId: string): Presence[] {
    return [...(this.presenceByProject.get(projectId)?.values() ?? [])];
  }

  // -- internals ------------------------------------------------------------

  private openSocket(): void {
    this.setStatus(
      this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
    );
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
      // Restore project subscriptions after every (re)connect.
      for (const projectId of this.joined) {
        this.send({ type: "project.join", projectId });
      }
      this.startPing();
    };

    ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      if (this.closedByUser) {
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // `onclose` follows and drives reconnect; nothing to do here.
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) {
      return;
    }
    this.clearTimers();
    this.setStatus("reconnecting");
    const delay = computeBackoff(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping", ts: Date.now() });
    }, CLIENT_PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
  }

  private send(message: ClientMessage): void {
    this.sendRaw(message);
  }

  /**
   * Send any protocol frame (Phase 1 or namespaced Phase 2). Dropped
   * when the socket is not open — callers that need durability (doc
   * subscriptions, Yjs updates) must track and re-send on reconnect.
   */
  sendRaw(message: ClientMessage | object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
    // If the socket is not open yet, joins stay in `this.joined` and
    // are flushed on `onopen`; other message types are safely dropped.
  }

  private handleMessage(raw: unknown): void {
    let message: InboundMessage;
    try {
      message = JSON.parse(String(raw)) as InboundMessage;
    } catch {
      this.events.onError?.("Malformed server message", "MALFORMED");
      return;
    }

    if (
      typeof (message as { type?: unknown }).type !== "string" ||
      (message as { type: unknown }).type === null
    ) {
      this.events.onError?.("Malformed server message", "MALFORMED");
      return;
    }

    switch (message.type) {
      case "connection.ready":
        this.connectionId = message.connectionId;
        this.selfUser = message.user;
        break;
      case "project.joined": {
        const room = new Map<string, Presence>();
        for (const p of message.presence) {
          room.set(p.connectionId, p);
        }
        this.presenceByProject.set(message.projectId, room);
        this.emitPresence(message.projectId);
        break;
      }
      case "project.left":
        this.presenceByProject.delete(message.projectId);
        this.emitPresence(message.projectId);
        break;
      case "presence.updated": {
        let room = this.presenceByProject.get(message.presence.projectId);
        if (!room) {
          room = new Map();
          this.presenceByProject.set(message.presence.projectId, room);
        }
        room.set(message.presence.connectionId, message.presence);
        this.events.onPresenceUpdated?.(message.presence);
        this.emitPresence(message.presence.projectId);
        break;
      }
      case "presence.removed": {
        this.presenceByProject
          .get(message.projectId)
          ?.delete(message.connectionId);
        this.events.onPresenceRemoved?.(message);
        this.emitPresence(message.projectId);
        break;
      }
      case "pong":
        break;
      case "error":
        if (message.code === "UNAUTHORIZED") {
          // Session is invalid — retrying would hot-loop. Stop and
          // let the app re-authenticate before reconnecting.
          this.closedByUser = true;
          this.clearTimers();
          this.ws?.close(4000, "unauthorized");
          this.setStatus("closed");
        }
        this.events.onError?.(message.message, message.code);
        break;
      default:
        // Namespaced frames (editor.*, future ai.*, terminal.*) go to
        // subscribers; unhandled types are ignored, never fatal.
        for (const listener of [...this.messageListeners]) {
          try {
            listener(message);
          } catch {
            // Listener failures must not break the socket loop.
          }
        }
        break;
    }
  }

  private emitPresence(projectId: string): void {
    this.events.onPresence?.(this.presenceFor(projectId));
  }

  private setStatus(status: CollabConnectionStatus): void {
    this.status = status;
    this.events.onStatusChange?.(status);
  }
}
