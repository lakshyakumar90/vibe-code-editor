import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ServerMessage } from "@repo/collab";
import { attachCollabServer } from "./collab.server";
import type { AttachedCollab } from "./collab.server";

/**
 * Phase 1 integration tests: real HTTP upgrade + real WS frames against
 * an ephemeral server. Session + access are injected doubles so no DB
 * or Better Auth instance is required.
 */

const USERS: Record<
  string,
  { id: string; name: string; email: string; image: string | null }
> = {
  alice: { id: "u-alice", name: "Alice", email: "alice@x.test", image: null },
  bob: { id: "u-bob", name: "Bob", email: "bob@x.test", image: null },
  mallory: {
    id: "u-mallory",
    name: "Mallory",
    email: "mallory@x.test",
    image: null,
  },
};

// `${userId}:${projectId}` entries grant access. Everything else is denied.
let accessGrants = new Set<string>();

function canAccess(userId: string, projectId: string): boolean {
  if (projectId === "missing-project") {
    return false;
  }
  return accessGrants.has(`${userId}:${projectId}`);
}

let httpServer: ReturnType<typeof createServer>;
let attached: AttachedCollab;
let wsUrl: string;
const sockets: WebSocket[] = [];
// Messages arriving between TCP open and `collect()` attach are buffered
// here so `connection.ready` can never be missed by a slow listener.
const earlyBuffers = new WeakMap<WebSocket, string[]>();

function connect(user?: keyof typeof USERS): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers =
      user !== undefined ? { "x-test-user": USERS[user]!.id } : {};
    const ws = new WebSocket(wsUrl, { headers });
    sockets.push(ws);
    const early: string[] = [];
    earlyBuffers.set(ws, early);
    ws.on("message", (data) => {
      early.push(data.toString());
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`unexpected-response:${res.statusCode}`));
    });
  });
}

interface Collected {
  messages: ServerMessage[];
  waitFor: (
    predicate: (m: ServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<ServerMessage>;
}

function collect(ws: WebSocket): Collected {
  const messages: ServerMessage[] = [];
  const push = (raw: string): void => {
    try {
      messages.push(JSON.parse(raw) as ServerMessage);
    } catch {
      // collect only tracks valid server frames
    }
  };
  // Seed anything that arrived before this listener attached.
  for (const raw of earlyBuffers.get(ws) ?? []) {
    push(raw);
  }
  const waiters: Array<{
    predicate: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  ws.on("message", (data) => {
    let parsed: ServerMessage;
    try {
      parsed = JSON.parse(data.toString()) as ServerMessage;
    } catch {
      return;
    }
    messages.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      if (waiter.predicate(parsed)) {
        clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        waiter.resolve(parsed);
      }
    }
  });
  return {
    messages,
    waitFor(predicate, timeoutMs = 5000) {
      const existing = messages.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) {
            waiters.splice(idx, 1);
          }
          reject(new Error("Timed out waiting for server message"));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

function send(ws: WebSocket, payload: unknown): void {
  ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
}

function closeAll(): Promise<void> {
  return new Promise((resolve) => {
    const pending = sockets.splice(0).filter((ws) => {
      // Already fully closed: nothing to wait for. CONNECTING sockets
      // cannot be closed cleanly either — terminate them.
      if (ws.readyState === WebSocket.CLOSED) {
        return false;
      }
      if (ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        return false;
      }
      return true;
    });
    if (pending.length === 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      // Safety net: never hang the afterEach hook on a dead socket.
      for (const ws of pending) {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
      resolve();
    }, 3000);
    let remaining = pending.length;
    const done = (): void => {
      remaining -= 1;
      if (remaining === 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    for (const ws of pending) {
      try {
        ws.once("close", done);
        ws.close();
      } catch {
        done();
      }
    }
  });
}

beforeEach(async () => {
  accessGrants = new Set([
    "u-alice:p1",
    "u-bob:p1",
    "u-alice:p2",
    // Mallory has no grants anywhere.
  ]);
  httpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  attached = attachCollabServer(httpServer, {
    sessionResolver: async (headers) => {
      const header = headers["x-test-user"];
      const id = Array.isArray(header) ? header[0] : header;
      const user = Object.values(USERS).find((u) => u.id === id);
      return user ?? null;
    },
    accessCheck: async (userId, projectId) => {
      if (projectId === "missing-project") {
        return { ok: false, code: "PROJECT_NOT_FOUND" };
      }
      return canAccess(userId, projectId)
        ? { ok: true }
        : { ok: false, code: "FORBIDDEN" };
    },
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${port}/ws/collab`;
});

afterEach(async () => {
  await closeAll();
  attached.close();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
});

describe("collab gateway integration", () => {
  it("authenticated user can connect and receives connection.ready", async () => {
    const ws = await connect("alice");
    const inbox = collect(ws);
    const ready = await inbox.waitFor((m) => m.type === "connection.ready");
    expect(ready.type).toBe("connection.ready");
    if (ready.type === "connection.ready") {
      expect(ready.user.id).toBe("u-alice");
      expect(ready.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("unauthenticated user is rejected with 401", async () => {
    await expect(connect(undefined)).rejects.toThrow(
      "unexpected-response:401",
    );
  });

  it("authorized member can join and gets a presence snapshot", async () => {
    const ws = await connect("alice");
    const inbox = collect(ws);
    await inbox.waitFor((m) => m.type === "connection.ready");
    send(ws, { type: "project.join", projectId: "p1" });
    const joined = await inbox.waitFor((m) => m.type === "project.joined");
    expect(joined.type).toBe("project.joined");
    if (joined.type === "project.joined") {
      expect(joined.projectId).toBe("p1");
      expect(joined.presence).toHaveLength(1);
      expect(joined.presence[0]?.userId).toBe("u-alice");
    }
  });

  it("unauthorized user cannot join (FORBIDDEN) and unknown project 404s", async () => {
    const ws = await connect("mallory");
    const inbox = collect(ws);
    await inbox.waitFor((m) => m.type === "connection.ready");
    send(ws, { type: "project.join", projectId: "p1" });
    const denied = await inbox.waitFor(
      (m) => m.type === "error" && m.requestType === "project.join",
    );
    expect(denied.type).toBe("error");
    if (denied.type === "error") {
      expect(denied.code).toBe("FORBIDDEN");
    }

    send(ws, { type: "project.join", projectId: "missing-project" });
    const missing = await inbox.waitFor(
      (m) =>
        m.type === "error" &&
        m.requestType === "project.join" &&
        (m as { code?: string }).code === "PROJECT_NOT_FOUND",
    );
    expect(missing.type).toBe("error");
  });

  it("presence appears to other connected users", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const aliceInbox = collect(alice);
    const bobInbox = collect(bob);
    await aliceInbox.waitFor((m) => m.type === "connection.ready");
    await bobInbox.waitFor((m) => m.type === "connection.ready");

    send(bob, { type: "project.join", projectId: "p1" });
    await bobInbox.waitFor((m) => m.type === "project.joined");

    send(alice, { type: "project.join", projectId: "p1" });
    await aliceInbox.waitFor((m) => m.type === "project.joined");

    // Bob learns about Alice via broadcast.
    const update = await bobInbox.waitFor(
      (m) =>
        m.type === "presence.updated" &&
        m.presence.userId === "u-alice" &&
        m.presence.projectId === "p1",
    );
    expect(update.type).toBe("presence.updated");
    if (update.type === "presence.updated") {
      expect(update.presence.displayName).toBe("Alice");
      expect(update.presence.status).toBe("online");
    }
  });

  it("disconnect removes presence for remaining members", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const aliceInbox = collect(alice);
    const bobInbox = collect(bob);
    await aliceInbox.waitFor((m) => m.type === "connection.ready");
    await bobInbox.waitFor((m) => m.type === "connection.ready");
    send(alice, { type: "project.join", projectId: "p1" });
    send(bob, { type: "project.join", projectId: "p1" });
    await aliceInbox.waitFor((m) => m.type === "project.joined");
    await bobInbox.waitFor((m) => m.type === "project.joined");

    alice.close();
    const removed = await bobInbox.waitFor(
      (m) => m.type === "presence.removed" && m.userId === "u-alice",
    );
    expect(removed.type).toBe("presence.removed");
    if (removed.type === "presence.removed") {
      expect(removed.projectId).toBe("p1");
    }
  });

  it("reconnect restores presence", async () => {
    const bob = await connect("bob");
    const bobInbox = collect(bob);
    await bobInbox.waitFor((m) => m.type === "connection.ready");
    send(bob, { type: "project.join", projectId: "p1" });
    await bobInbox.waitFor((m) => m.type === "project.joined");

    let alice = await connect("alice");
    let aliceInbox = collect(alice);
    await aliceInbox.waitFor((m) => m.type === "connection.ready");
    send(alice, { type: "project.join", projectId: "p1" });
    await aliceInbox.waitFor((m) => m.type === "project.joined");

    alice.close();
    await bobInbox.waitFor(
      (m) => m.type === "presence.removed" && m.userId === "u-alice",
    );

    // Same user reconnects (new connectionId) and re-joins.
    alice = await connect("alice");
    aliceInbox = collect(alice);
    await aliceInbox.waitFor((m) => m.type === "connection.ready");
    send(alice, { type: "project.join", projectId: "p1" });
    const rejoined = await aliceInbox.waitFor(
      (m) => m.type === "project.joined",
    );
    expect(rejoined.type).toBe("project.joined");

    const restored = await bobInbox.waitFor(
      (m) =>
        m.type === "presence.updated" &&
        m.presence.userId === "u-alice" &&
        m.presence.projectId === "p1",
    );
    expect(restored.type).toBe("presence.updated");
  });

  it("malformed events are rejected but the connection survives", async () => {
    const ws = await connect("alice");
    const inbox = collect(ws);
    await inbox.waitFor((m) => m.type === "connection.ready");

    ws.send("{not valid json");
    const malformed = await inbox.waitFor(
      (m) => m.type === "error" && m.code === "MALFORMED",
    );
    expect(malformed.type).toBe("error");

    send(ws, { type: "definitely.unknown" });
    await inbox.waitFor(
      (m) =>
        m.type === "error" &&
        m.code === "MALFORMED" &&
        m.requestType === "definitely.unknown",
    );

    // Connection still usable afterwards.
    send(ws, { type: "project.join", projectId: "p1" });
    const joined = await inbox.waitFor((m) => m.type === "project.joined");
    expect(joined.type).toBe("project.joined");
  });

  it("client cannot impersonate another user", async () => {
    const ws = await connect("mallory");
    const inbox = collect(ws);
    await inbox.waitFor((m) => m.type === "connection.ready");

    // Mallory tries to smuggle a foreign userId into the payload.
    // The strict schema rejects the extra key...
    send(ws, {
      type: "project.join",
      projectId: "p1",
      userId: "u-alice",
    });
    const rejected = await inbox.waitFor(
      (m) => m.type === "error" && m.code === "MALFORMED",
    );
    expect(rejected.type).toBe("error");

    // ...and even where she IS allowed, presence carries her own id.
    accessGrants.add("u-mallory:p2");
    send(ws, { type: "project.join", projectId: "p2" });
    const joined = await inbox.waitFor(
      (m) => m.type === "project.joined" && m.projectId === "p2",
    );
    expect(joined.type).toBe("project.joined");
    if (joined.type === "project.joined") {
      expect(joined.presence[0]?.userId).toBe("u-mallory");
      expect(joined.presence.every((p) => p.userId !== "u-alice")).toBe(true);
    }
  });

  it("client cannot join another project's room without permission", async () => {
    const mallory = await connect("mallory");
    const malloryInbox = collect(mallory);
    await malloryInbox.waitFor((m) => m.type === "connection.ready");

    const alice = await connect("alice");
    const aliceInbox = collect(alice);
    await aliceInbox.waitFor((m) => m.type === "connection.ready");
    send(alice, { type: "project.join", projectId: "p1" });
    await aliceInbox.waitFor((m) => m.type === "project.joined");

    // Mallory (no grant on p1) is denied; Alice sees nothing from her.
    send(mallory, { type: "project.join", projectId: "p1" });
    const denied = await malloryInbox.waitFor(
      (m) =>
        m.type === "error" &&
        m.code === "FORBIDDEN" &&
        m.requestType === "project.join",
    );
    expect(denied.type).toBe("error");

    // Mallory's presence.update for a room she never joined is refused...
    send(mallory, {
      type: "presence.update",
      projectId: "p1",
      status: "away",
    });
    const notInRoom = await malloryInbox.waitFor(
      (m) => m.type === "error" && m.code === "NOT_IN_PROJECT",
    );
    expect(notInRoom.type).toBe("error");

    // ...and rooms are isolated: p2-only Alice never sees p1 traffic.
    send(alice, { type: "project.leave", projectId: "p1" });
    await aliceInbox.waitFor((m) => m.type === "project.left");
    send(alice, { type: "project.join", projectId: "p2" });
    await aliceInbox.waitFor(
      (m) => m.type === "project.joined" && m.projectId === "p2",
    );
  });

  it("project.leave removes the leaver and notifies others", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const aliceInbox = collect(alice);
    const bobInbox = collect(bob);
    await aliceInbox.waitFor((m) => m.type === "connection.ready");
    await bobInbox.waitFor((m) => m.type === "connection.ready");
    // Bob joins first so Alice's later join reaches him as a broadcast.
    send(bob, { type: "project.join", projectId: "p1" });
    await bobInbox.waitFor((m) => m.type === "project.joined");
    send(alice, { type: "project.join", projectId: "p1" });
    await aliceInbox.waitFor((m) => m.type === "project.joined");
    // Drain the join broadcasts so the next wait is unambiguous.
    await bobInbox.waitFor(
      (m) => m.type === "presence.updated" && m.presence.userId === "u-alice",
    );

    send(alice, { type: "project.leave", projectId: "p1" });
    await aliceInbox.waitFor((m) => m.type === "project.left");
    const removed = await bobInbox.waitFor(
      (m) => m.type === "presence.removed" && m.userId === "u-alice",
    );
    expect(removed.type).toBe("presence.removed");
  });

  it("ping receives a pong", async () => {
    const ws = await connect("alice");
    const inbox = collect(ws);
    await inbox.waitFor((m) => m.type === "connection.ready");
    send(ws, { type: "ping", ts: 42 });
    const pong = await inbox.waitFor((m) => m.type === "pong");
    expect(pong).toEqual({ type: "pong", ts: 42 });
  });
});
