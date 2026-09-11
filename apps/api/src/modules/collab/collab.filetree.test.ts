import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { attachCollabServer } from "./collab.server";
import type { AttachedCollab } from "./collab.server";
import { emitFileTreeChanged } from "../projects/files/file.events";

/**
 * File-tree hint fan-out over the existing `/ws/collab` socket.
 * A tree mutation in the project room reaches every member as a
 * `file.tree.changed` hint (clients re-fetch over REST — the hint
 * carries no file data). Non-members never join the room, so they
 * never receive hints.
 */

const USERS = {
  ravi: { id: "u-ravi", name: "Ravi", email: "ravi@x.test", image: null },
  ananya: {
    id: "u-ananya",
    name: "Ananya",
    email: "ananya@x.test",
    image: null,
  },
} as const;

type UserKey = keyof typeof USERS;

let accessGrants = new Set<string>();
let httpServer: ReturnType<typeof createServer>;
let attached: AttachedCollab;
let wsUrl: string;
const sockets: WebSocket[] = [];
const earlyBuffers = new WeakMap<WebSocket, string[]>();

function connect(user: UserKey): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { "x-test-user": USERS[user].id },
    });
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

interface Inbox {
  waitFor: (
    predicate: (m: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
}

function collect(ws: WebSocket): Inbox {
  const messages: Record<string, unknown>[] = [];
  const push = (raw: string): void => {
    try {
      messages.push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      // ignore non-JSON
    }
  };
  for (const raw of earlyBuffers.get(ws) ?? []) {
    push(raw);
  }
  const waiters: Array<{
    predicate: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  ws.on("message", (data) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>;
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
    waitFor(predicate, timeoutMs = 5000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) waiters.splice(idx, 1);
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
      if (ws.readyState === WebSocket.CLOSED) return false;
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
  accessGrants = new Set(["u-ravi:p1", "u-ananya:p1"]);
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
      return accessGrants.has(`${userId}:${projectId}`)
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

describe("file.tree.changed hints", () => {
  it("both room members receive the hint with the project id", async () => {
    const ravi = await connect("ravi");
    const ananya = await connect("ananya");
    const raviInbox = collect(ravi);
    const ananyaInbox = collect(ananya);
    await raviInbox.waitFor((m) => m["type"] === "connection.ready");
    await ananyaInbox.waitFor((m) => m["type"] === "connection.ready");
    send(ravi, { type: "project.join", projectId: "p1" });
    send(ananya, { type: "project.join", projectId: "p1" });
    await raviInbox.waitFor((m) => m["type"] === "project.joined");
    await ananyaInbox.waitFor((m) => m["type"] === "project.joined");

    // Same path the file controller uses after a rename/create/delete/move.
    emitFileTreeChanged("p1");

    const seenByRavi = await raviInbox.waitFor(
      (m) => m["type"] === "file.tree.changed",
    );
    const seenByAnanya = await ananyaInbox.waitFor(
      (m) => m["type"] === "file.tree.changed",
    );
    expect(seenByRavi["projectId"]).toBe("p1");
    expect(seenByAnanya["projectId"]).toBe("p1");
  });

  it("members of another project do not receive the hint", async () => {
    const ravi = await connect("ravi");
    const inbox = collect(ravi);
    await inbox.waitFor((m) => m["type"] === "connection.ready");
    // Ravi never joins p1 here — he must not observe p1 hints.
    emitFileTreeChanged("p1");
    await expect(
      inbox.waitFor((m) => m["type"] === "file.tree.changed", 500),
    ).rejects.toThrow("Timed out waiting for server message");
  });
});
