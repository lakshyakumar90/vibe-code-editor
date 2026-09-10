import {
  CLIENT_PING_INTERVAL_MS,
  COLLAB_WS_PATH,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "@repo/collab";
import type {
  ClientMessage,
  CollabUser,
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
 * Reusable Phase 1 collaboration client (rooms + presence only).
 *
 * - One instance = one authenticated connection (Better Auth cookies
 *   are sent automatically by the browser WebSocket handshake).
 * - Maintains the joined-project set and re-sends `project.join`
 *   after every reconnect.
 * - Exponential-backoff reconnect; 401 responses stop retrying
 *   (re-auth is required instead of a hot loop).
 *
 * Phase 1 ships the transport only — no React hook is mounted and
 * nothing here touches Monaco, AI, or terminal code.
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

  get joinedProjects(): string[] {
    return [...this.joined];
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
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
    // If the socket is not open yet, joins stay in `this.joined` and
    // are flushed on `onopen`; other message types are safely dropped.
  }

  private handleMessage(raw: unknown): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(raw)) as ServerMessage;
    } catch {
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
