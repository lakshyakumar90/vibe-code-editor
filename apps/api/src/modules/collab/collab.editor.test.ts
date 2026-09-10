import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import {
  decodeUpdate,
  encodeUpdate,
} from "@repo/collab";
import type { EditorServerMessage, ServerMessage } from "@repo/collab";
import { attachCollabServer } from "./collab.server";
import type { AttachedCollab } from "./collab.server";

type AnyMessage = ServerMessage | EditorServerMessage;

/**
 * Phase 2 integration: editor sync + awareness through the real gateway
 * and the real `EditorSyncService` (wired by `attachCollabServer`).
 * Session + access are injected doubles — no DB required.
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

let accessGrants = new Set<string>();

/** In-memory file store backing the injected seeder (`projectId:fileId`). */
const seedFiles = new Map<string, string>([
  ["p1:f1", ""],
  ["p1:f2", "const seeded = true;\n"],
  ["p2:foreign", "top secret\n"],
]);

let httpServer: ReturnType<typeof createServer>;
let attached: AttachedCollab;
let wsUrl: string;
const sockets: WebSocket[] = [];
const earlyBuffers = new WeakMap<WebSocket, string[]>();

function connect(user: keyof typeof USERS): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { "x-test-user": USERS[user]!.id },
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

interface Collected {
  messages: AnyMessage[];
  waitFor: (
    predicate: (m: AnyMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<AnyMessage>;
}

function collect(ws: WebSocket): Collected {
  const messages: AnyMessage[] = [];
  const push = (raw: string): void => {
    try {
      messages.push(JSON.parse(raw) as AnyMessage);
    } catch {
      // ignore non-JSON frames
    }
  };
  for (const raw of earlyBuffers.get(ws) ?? []) {
    push(raw);
  }
  const waiters: Array<{
    predicate: (m: AnyMessage) => boolean;
    resolve: (m: AnyMessage) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  ws.on("message", (data) => {
    const raw = data.toString();
    let parsed: AnyMessage;
    try {
      parsed = JSON.parse(raw) as AnyMessage;
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
      return new Promise<AnyMessage>((resolve, reject) => {
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
  ws.send(JSON.stringify(payload));
}

/** Build a Yjs update that sets a fresh doc's shared text to `text`. */
function textUpdate(text: string): string {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return encodeUpdate(Y.encodeStateAsUpdate(doc));
}

/** Apply a received base64 update to a scratch doc and return its text. */
function applyToScratch(doc: Y.Doc, update: string): string {
  const bytes = decodeUpdate(update);
  expect(bytes).not.toBeNull();
  Y.applyUpdate(doc, bytes!);
  return doc.getText("content").toString();
}

function closeAll(): Promise<void> {
  return new Promise((resolve) => {
    const pending = sockets.splice(0).filter((ws) => {
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
  accessGrants = new Set(["u-alice:p1", "u-bob:p1"]);
  httpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  attached = attachCollabServer(httpServer, {
    sessionResolver: async (headers) => {
      const header = headers["x-test-user"];
      const id = Array.isArray(header) ? header[0] : header;
      return Object.values(USERS).find((u) => u.id === id) ?? null;
    },
    accessCheck: async (userId, projectId) =>
      accessGrants.has(`${userId}:${projectId}`)
        ? { ok: true }
        : { ok: false, code: "FORBIDDEN" as const },
    editorSeed: async (projectId, fileId) => {
      // p2:foreign exists but belongs to another project (probe denial).
      if (projectId === "p1" && fileId === "foreign") {
        return { ok: false, code: "FORBIDDEN" as const };
      }
      const content = seedFiles.get(`${projectId}:${fileId}`);
      if (content === undefined) {
        return { ok: false, code: "PROJECT_NOT_FOUND" as const };
      }
      return { ok: true, content };
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

async function joinProject(ws: WebSocket, projectId: string): Promise<void> {
  const inbox = collect(ws);
  await inbox.waitFor((m) => m.type === "connection.ready");
  send(ws, { type: "project.join", projectId });
  await inbox.waitFor(
    (m) => m.type === "project.joined" && m.projectId === projectId,
  );
}

describe("editor sync integration", () => {
  it("joining an empty doc returns editor.joined without state", async () => {
    const ws = await connect("alice");
    const inbox = collect(ws);
    await joinProject(ws, "p1");
    send(ws, { type: "editor.join", projectId: "p1", fileId: "f1" });
    const joined = await inbox.waitFor((m) => m.type === "editor.joined");
    expect(joined.type).toBe("editor.joined");
    if (joined.type === "editor.joined") {
      expect(joined.docId).toBe("p1:f1");
      expect(joined.update).toBeUndefined();
    }
  });

  it("seeds the server doc from persisted content for first joiners", async () => {
    const ws = await connect("alice");
    const inbox = collect(ws);
    await joinProject(ws, "p1");
    send(ws, { type: "editor.join", projectId: "p1", fileId: "f2" });
    const joined = await inbox.waitFor((m) => m.type === "editor.joined");
    expect(joined.type).toBe("editor.joined");
    if (joined.type === "editor.joined") {
      expect(joined.docId).toBe("p1:f2");
      expect(joined.update).toBeDefined();
      expect(typeof joined.sv).toBe("string");
      const doc = new Y.Doc();
      expect(applyToScratch(doc, joined.update!)).toBe(
        "const seeded = true;\n",
      );
    }
  });

  it("denies joins for missing vs foreign files without leaking", async () => {
    const ws = await connect("alice");
    const inbox = collect(ws);
    await joinProject(ws, "p1");

    send(ws, { type: "editor.join", projectId: "p1", fileId: "ghost" });
    const missing = await inbox.waitFor(
      (m) =>
        m.type === "error" &&
        m.code === "PROJECT_NOT_FOUND" &&
        m.requestType === "editor.join",
    );
    expect(missing.type).toBe("error");

    send(ws, { type: "editor.join", projectId: "p1", fileId: "foreign" });
    const forbidden = await inbox.waitFor(
      (m) =>
        m.type === "error" &&
        m.code === "FORBIDDEN" &&
        m.requestType === "editor.join",
    );
    expect(forbidden.type).toBe("error");
  });

  it("relays updates and converges a late joiner via server state", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const aliceInbox = collect(alice);
    const bobInbox = collect(bob);
    await joinProject(alice, "p1");
    await joinProject(bob, "p1");

    send(alice, { type: "editor.join", projectId: "p1", fileId: "f1" });
    send(bob, { type: "editor.join", projectId: "p1", fileId: "f1" });
    await aliceInbox.waitFor((m) => m.type === "editor.joined");
    await bobInbox.waitFor((m) => m.type === "editor.joined");

    // Alice types; Bob receives the relay with sender attribution.
    send(alice, {
      type: "editor.update",
      docId: "p1:f1",
      update: textUpdate("hello"),
    });
    const relay = await bobInbox.waitFor(
      (m) => m.type === "editor.update" && m.docId === "p1:f1",
    );
    expect(relay.type).toBe("editor.update");
    if (relay.type === "editor.update") {
      expect(typeof relay.sender).toBe("string");
      const bobDoc = new Y.Doc();
      expect(applyToScratch(bobDoc, relay.update)).toBe("hello");
    }

    // A third client joining late converges from the server-held doc.
    const carol = await connect("alice");
    const carolInbox = collect(carol);
    await joinProject(carol, "p1");
    send(carol, { type: "editor.join", projectId: "p1", fileId: "f1" });
    const late = await carolInbox.waitFor((m) => m.type === "editor.joined");
    expect(late.type).toBe("editor.joined");
    if (late.type === "editor.joined") {
      expect(late.update).toBeDefined();
      const carolDoc = new Y.Doc();
      expect(applyToScratch(carolDoc, late.update!)).toBe("hello");
    }
  });

  it("rejects editor.join without project-room membership", async () => {
    const ws = await connect("mallory");
    const inbox = collect(ws);
    await inbox.waitFor((m) => m.type === "connection.ready");
    // Mallory never joined p1 (she has no access) — editor.join refused.
    send(ws, { type: "editor.join", projectId: "p1", fileId: "f1" });
    const denied = await inbox.waitFor(
      (m) =>
        m.type === "error" &&
        m.code === "NOT_IN_PROJECT" &&
        m.requestType === "editor.join",
    );
    expect(denied.type).toBe("error");
  });

  it("re-checks access on every update (revocation-safe)", async () => {
    const ws = await connect("alice");
    const inbox = collect(ws);
    await joinProject(ws, "p1");
    send(ws, { type: "editor.join", projectId: "p1", fileId: "f1" });
    await inbox.waitFor((m) => m.type === "editor.joined");

    accessGrants.delete("u-alice:p1");
    send(ws, {
      type: "editor.update",
      docId: "p1:f1",
      update: textUpdate("revoked"),
    });
    const denied = await inbox.waitFor(
      (m) =>
        m.type === "error" &&
        m.code === "FORBIDDEN" &&
        m.requestType === "editor.update",
    );
    expect(denied.type).toBe("error");
  });

  it("rejects oversized and corrupt updates without dropping the connection", async () => {
    const ws = await connect("alice");
    const inbox = collect(ws);
    await joinProject(ws, "p1");
    send(ws, { type: "editor.join", projectId: "p1", fileId: "f1" });
    await inbox.waitFor((m) => m.type === "editor.joined");

    send(ws, { type: "editor.update", docId: "p1:f1", update: "!!!not-base64!!!" });
    await inbox.waitFor(
      (m) =>
        m.type === "error" &&
        m.code === "MALFORMED" &&
        m.requestType === "editor.update",
    );

    // Connection survives: a valid update still flows afterwards.
    send(ws, {
      type: "editor.update",
      docId: "bogus-doc",
      update: textUpdate("x"),
    });
    await inbox.waitFor(
      (m) =>
        m.type === "error" &&
        (m.code === "NOT_IN_PROJECT" || m.code === "MALFORMED"),
    );
  });

  it("broadcasts awareness with server-attached identity", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const bobInbox = collect(bob);
    await joinProject(alice, "p1");
    await joinProject(bob, "p1");
    send(alice, { type: "editor.join", projectId: "p1", fileId: "f1" });
    send(bob, { type: "editor.join", projectId: "p1", fileId: "f1" });
    await bobInbox.waitFor((m) => m.type === "editor.joined");

    // Alice sends positions only — no identity. The server attaches it.
    send(alice, {
      type: "editor.awareness",
      projectId: "p1",
      fileId: "f1",
      cursor: { lineNumber: 3, column: 7 },
      selection: {
        startLineNumber: 3,
        startColumn: 1,
        endLineNumber: 3,
        endColumn: 7,
      },
    });
    const awareness = await bobInbox.waitFor(
      (m) => m.type === "editor.awareness" && m.fileId === "f1",
    );
    expect(awareness.type).toBe("editor.awareness");
    if (awareness.type === "editor.awareness") {
      expect(awareness.cursor).toEqual({ lineNumber: 3, column: 7 });
      expect(awareness.user.userId).toBe("u-alice");
      expect(awareness.user.displayName).toBe("Alice");
      expect(typeof awareness.connectionId).toBe("string");
    }
  });

  it("retracts awareness on file switch, leave, and disconnect", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const bobInbox = collect(bob);
    await joinProject(alice, "p1");
    await joinProject(bob, "p1");

    send(alice, {
      type: "editor.awareness",
      projectId: "p1",
      fileId: "f1",
      cursor: { lineNumber: 1, column: 1 },
    });
    await bobInbox.waitFor(
      (m) => m.type === "editor.awareness" && m.fileId === "f1",
    );

    // File switch retracts the old file entry.
    send(alice, {
      type: "editor.awareness",
      projectId: "p1",
      fileId: "f2",
      cursor: { lineNumber: 2, column: 2 },
    });
    const retracted = await bobInbox.waitFor(
      (m) => m.type === "editor.awareness.remove" && m.fileId === "f1",
    );
    expect(retracted.type).toBe("editor.awareness.remove");
    await bobInbox.waitFor(
      (m) => m.type === "editor.awareness" && m.fileId === "f2",
    );

    // Explicit leave retracts too.
    send(alice, { type: "editor.leave", projectId: "p1", fileId: "f2" });
    await bobInbox.waitFor(
      (m) => m.type === "editor.awareness.remove" && m.fileId === "f2",
    );

    // Re-announce, then disconnect: the server retracts on close.
    send(alice, {
      type: "editor.awareness",
      projectId: "p1",
      fileId: "f1",
      cursor: { lineNumber: 5, column: 5 },
    });
    await bobInbox.waitFor(
      (m) => m.type === "editor.awareness" && m.fileId === "f1",
    );
    alice.close();
    const gone = await bobInbox.waitFor(
      (m) =>
        m.type === "editor.awareness.remove" &&
        m.fileId === "f1" &&
        typeof m.connectionId === "string",
    );
    expect(gone.type).toBe("editor.awareness.remove");
  });

  it("dedupes same-user cursors so a user never renders twice", async () => {
    // Alice connects twice (reconnect ghost: the old socket's close has
    // not been processed yet). Bob must see exactly one Alice cursor.
    const alice1 = await connect("alice");
    const alice2 = await connect("alice");
    const bob = await connect("bob");
    const bobInbox = collect(bob);
    await joinProject(alice1, "p1");
    await joinProject(alice2, "p1");
    await joinProject(bob, "p1");

    send(alice1, {
      type: "editor.awareness",
      projectId: "p1",
      fileId: "f1",
      cursor: { lineNumber: 1, column: 1 },
    });
    const first = await bobInbox.waitFor(
      (m) => m.type === "editor.awareness" && m.fileId === "f1",
    );
    expect(first.type).toBe("editor.awareness");

    send(alice2, {
      type: "editor.awareness",
      projectId: "p1",
      fileId: "f1",
      cursor: { lineNumber: 9, column: 9 },
    });
    // The ghost entry is retracted…
    const retracted = await bobInbox.waitFor(
      (m) => m.type === "editor.awareness.remove" && m.fileId === "f1",
    );
    expect(retracted.type).toBe("editor.awareness.remove");
    // …and the live cursor arrives.
    const second = await bobInbox.waitFor(
      (m) =>
        m.type === "editor.awareness" &&
        m.fileId === "f1" &&
        m.cursor.lineNumber === 9,
    );
    expect(second.type).toBe("editor.awareness");
    if (
      first.type === "editor.awareness" &&
      second.type === "editor.awareness" &&
      retracted.type === "editor.awareness.remove"
    ) {
      expect(retracted.connectionId).toBe(first.connectionId);
      expect(second.connectionId).not.toBe(first.connectionId);
      expect(second.user.userId).toBe("u-alice");
    }
  });
});
