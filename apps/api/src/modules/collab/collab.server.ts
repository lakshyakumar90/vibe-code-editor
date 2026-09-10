import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { resolveSessionFromHeaders } from "@repo/auth";
import { COLLAB_WS_PATH, HEARTBEAT_INTERVAL_MS } from "@repo/collab";
import { CollabGateway } from "./collab.gateway";
import type { AccessCheck } from "./collab.gateway";
import { checkProjectAccess } from "./collab.access";
import { registerEditorHandlers } from "./collab.editor";
import type { DocSeeder } from "./collab.editor";

export interface AttachCollabOptions {
  sessionResolver?: (
    headers: Record<string, string | string[] | undefined>,
  ) => Promise<{ id: string; name?: string | null; email?: string | null; image?: string | null } | null>;
  accessCheck?: AccessCheck;
  /** Override the editor DB seeder (tests inject an in-memory double). */
  editorSeed?: DocSeeder;
}

export interface AttachedCollab {
  gateway: CollabGateway;
  wss: WebSocketServer;
  close: () => void;
}

const defaultAccessCheck: AccessCheck = async (userId, projectId) => {
  const result = await checkProjectAccess(userId, projectId);
  return result.ok ? { ok: true } : { ok: false, code: result.code };
};

/**
 * Attach the collaboration WebSocket endpoint to the existing Express
 * HTTP server. Only `GET /ws/collab` upgrades are handled here; all
 * other traffic (REST, Better Auth) is untouched.
 */
export function attachCollabServer(
  server: HttpServer,
  opts: AttachCollabOptions = {},
): AttachedCollab {
  const gateway = new CollabGateway(
    opts.accessCheck ?? defaultAccessCheck,
  );
  // Phase 2: collaborative editing (Yjs updates + awareness) on the same
  // socket. AI-agent / terminal namespaces stay unregistered.
  registerEditorHandlers(
    gateway,
    opts.accessCheck ?? defaultAccessCheck,
    opts.editorSeed,
  );
  const wss = new WebSocketServer({ noServer: true });

  const sessionResolver =
    opts.sessionResolver ??
    (async (headers) => {
      const session = await resolveSessionFromHeaders(headers);
      if (!session) {
        return null;
      }
      const user = session.user as {
        id: string;
        name?: string | null;
        email?: string | null;
        image?: string | null;
      };
      return {
        id: user.id,
        name: user.name ?? null,
        email: user.email ?? null,
        image: user.image ?? null,
      };
    });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== COLLAB_WS_PATH) {
      return;
    }

    void (async () => {
      let session: Awaited<ReturnType<typeof sessionResolver>>;
      try {
        session = await sessionResolver(
          req.headers as Record<string, string | string[] | undefined>,
        );
      } catch {
        session = null;
      }

      if (!session) {
        try {
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
        } finally {
          socket.destroy();
        }
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        gateway.handleConnection(ws, session);
      });
    })();
  });

  // ws-level heartbeat: drop dead TCP peers so presence cannot go stale.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const socket = ws as WebSocket & { isAlive?: boolean };
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        // `close` / sweep handles cleanup.
      }
    }
    gateway.sweepStale();
  }, HEARTBEAT_INTERVAL_MS);

  heartbeat.unref?.();

  wss.on("connection", (ws: WebSocket & { isAlive?: boolean }) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
  });

  return {
    gateway,
    wss,
    close: () => {
      clearInterval(heartbeat);
      wss.close();
    },
  };
}
