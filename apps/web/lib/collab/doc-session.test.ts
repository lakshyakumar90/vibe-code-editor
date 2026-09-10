import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { decodeUpdate } from "@repo/collab";
import {
  DocSession,
  DocSessionManager,
  REMOTE_ORIGIN,
} from "./doc-session";

/** Drive a local keystroke: transact on the text with a local origin. */
function type(session: DocSession, text: string, at?: number): void {
  session.doc.transact(() => {
    session.text.insert(at ?? session.text.length, text);
  }, "local-test");
}

describe("DocSession identity", () => {
  it("derives deterministic project/file-scoped doc ids", () => {
    const manager = new DocSessionManager();
    const a = manager.getOrCreate("p1", "f1");
    const b = manager.getOrCreate("p1", "f1");
    expect(a).toBe(b);
    expect(a.docId).toBe("p1:f1");
    expect(manager.getOrCreate("p1", "f2").docId).toBe("p1:f2");
    expect(manager.getOrCreate("p2", "f1").docId).toBe("p2:f1");
    expect(manager.size()).toBe(3);
  });

  it("never creates duplicate Y.Docs for the same file in one tab", () => {
    const manager = new DocSessionManager();
    const first = manager.getOrCreate("p1", "f1");
    for (let i = 0; i < 5; i++) {
      expect(manager.getOrCreate("p1", "f1")).toBe(first);
    }
    expect(manager.size()).toBe(1);
  });
});

describe("DocSession lifecycle", () => {
  it("seeds from DB content once, then ignores later seeds", () => {
    const session = new DocSession("p1", "f1");
    expect(session.currentState).toBe("UNINITIALIZED");
    session.seedLocal("hello");
    expect(session.currentState).toBe("SYNCING");
    expect(session.getText()).toBe("hello");
    session.seedLocal("overwrite attempt");
    expect(session.getText()).toBe("hello");
  });

  it("emits local updates only when READY (loop prevention)", () => {
    const emitted: string[] = [];
    const session = new DocSession("p1", "f1", {
      onLocalUpdate: (_docId, update) => {
        emitted.push(update);
      },
    });
    session.seedLocal("base");
    type(session, "!");
    // Seeding + pre-READY typing stay in the doc, never emitted.
    expect(emitted).toHaveLength(0);
    expect(session.handleJoined()).toBe(true);
    type(session, "?");
    expect(emitted).toHaveLength(1);
  });

  it("never re-emits remote updates (feedback-loop prevention)", () => {
    const emitted: string[] = [];
    const session = new DocSession("p1", "f1", {
      onLocalUpdate: (_docId, update) => {
        emitted.push(update);
      },
    });
    session.seedLocal("");
    expect(session.handleJoined()).toBe(true);

    const remote = new Y.Doc();
    remote.getText("content").insert(0, "from-peer");
    const bytes = Y.encodeStateAsUpdate(remote);
    const b64 = Buffer.from(bytes).toString("base64");
    expect(session.applyRemoteUpdate(b64)).toBe(true);
    expect(session.getText()).toBe("from-peer");
    expect(emitted).toHaveLength(0);
  });

  it("rejects corrupt remote payloads without diverging", () => {
    const session = new DocSession("p1", "f1");
    session.seedLocal("keep");
    expect(session.handleJoined()).toBe(true);
    expect(session.applyRemoteUpdate("!!!")).toBe(false);
    expect(session.getText()).toBe("keep");
  });
});

describe("two-client convergence (pure Yjs)", () => {
  function linkedPair(): [DocSession, DocSession] {
    const a = new DocSession("p1", "f1", {
      onLocalUpdate: (_id, u) => {
        const bytes = decodeUpdate(u);
        if (bytes) {
          Y.applyUpdate(b.doc, bytes, REMOTE_ORIGIN);
        }
      },
    });
    const b = new DocSession("p1", "f1", {
      onLocalUpdate: (_id, u) => {
        const bytes = decodeUpdate(u);
        if (bytes) {
          Y.applyUpdate(a.doc, bytes, REMOTE_ORIGIN);
        }
      },
    });
    for (const s of [a, b]) {
      s.seedLocal("");
      s.handleJoined();
    }
    return [a, b];
  }

  it("A edits → B sees the edit", () => {
    const [a, b] = linkedPair();
    type(a, "hello");
    expect(b.getText()).toBe("hello");
  });

  it("B edits the same region → A sees the edit", () => {
    const [a, b] = linkedPair();
    type(a, "hello");
    expect(b.getText()).toBe("hello");
    b.doc.transact(() => {
      b.text.delete(0, 5);
      b.text.insert(0, "world");
    }, "local-test");
    expect(a.getText()).toBe("world");
  });

  it("near-simultaneous edits converge to identical content", () => {
    // Two replicas diverge from the same base, then exchange full states.
    const solo1 = new Y.Doc();
    const solo2 = new Y.Doc();
    solo1.getText("content").insert(0, "base");
    Y.applyUpdate(solo2, Y.encodeStateAsUpdate(solo1));
    solo1.getText("content").insert(4, "A");
    solo2.getText("content").insert(4, "B");
    const relayA: string[] = [];
    const relayB: string[] = [];
    relayA.push(
      Buffer.from(Y.encodeStateAsUpdate(solo1)).toString("base64"),
    );
    relayB.push(
      Buffer.from(Y.encodeStateAsUpdate(solo2)).toString("base64"),
    );
    for (const u of relayA) {
      const bytes = decodeUpdate(u);
      if (bytes) {
        Y.applyUpdate(solo2, bytes);
      }
    }
    for (const u of relayB) {
      const bytes = decodeUpdate(u);
      if (bytes) {
        Y.applyUpdate(solo1, bytes);
      }
    }
    expect(solo1.getText("content").toString()).toBe(
      solo2.getText("content").toString(),
    );
  });
});

describe("reconnect / resync", () => {
  it("retained doc + server snapshot converge, then the local diff pushes", () => {
    // A and the server share "hello". A disconnects; B advances the
    // server to "hello world". A reconnects with retained state.
    const serverDoc = new Y.Doc();
    serverDoc.getText("content").insert(0, "hello");

    const session = new DocSession("p1", "f1");
    Y.applyUpdate(
      session.doc,
      Y.encodeStateAsUpdate(serverDoc),
      REMOTE_ORIGIN,
    );
    session.seedLocal("ignored — retained doc wins");
    expect(session.handleJoined()).toBe(true);
    expect(session.getText()).toBe("hello");

    // Offline typing while disconnected.
    type(session, " local");

    // Reconnect: server snapshot first…
    serverDoc.getText("content").insert(5, " world");
    const snapshot = Buffer.from(
      Y.encodeStateAsUpdate(serverDoc),
    ).toString("base64");
    const serverSv = Buffer.from(
      Y.encodeStateVector(serverDoc),
    ).toString("base64");
    expect(session.handleJoined(snapshot)).toBe(true);
    expect(session.getText()).toContain("world");
    expect(session.getText()).toContain("local");

    // …then the client diff carries exactly the missing ops back.
    const push = session.diffAgainst(serverSv);
    expect(push).not.toBeNull();
    const pushBytes = decodeUpdate(push!);
    expect(pushBytes).not.toBeNull();
    const before = serverDoc.getText("content").toString();
    Y.applyUpdate(serverDoc, pushBytes!);
    expect(serverDoc.getText("content").toString()).toContain("local");
    expect(before).not.toContain("local");
  });

  it("diffAgainst is null when converged (no empty pushes)", () => {
    const session = new DocSession("p1", "f1");
    session.seedLocal("same");
    expect(session.handleJoined()).toBe(true);
    const sv = Buffer.from(Y.encodeStateVector(session.doc)).toString(
      "base64",
    );
    expect(session.diffAgainst(sv)).toBeNull();
    expect(session.diffAgainst("!!!")).toBeNull();
  });

  it("unsaved local changes survive a resync (never silently dropped)", () => {
    const session = new DocSession("p1", "f1");
    session.seedLocal("saved-base");
    expect(session.handleJoined()).toBe(true);
    type(session, " + unsaved work");
    // Server restarts empty (worst case): our diff still carries everything.
    const push = session.diffAgainst();
    expect(push).not.toBeNull();
    const fresh = new Y.Doc();
    const bytes = decodeUpdate(push!);
    Y.applyUpdate(fresh, bytes!);
    expect(fresh.getText("content").toString()).toBe("saved-base + unsaved work");
  });
});

describe("external content (AI / reset path)", () => {
  it("replaces whole content as a local op peers converge on", () => {
    const emitted: string[] = [];
    const session = new DocSession("p1", "f1", {
      onLocalUpdate: (_docId, update) => {
        emitted.push(update);
      },
    });
    session.seedLocal("old content");
    expect(session.handleJoined()).toBe(true);

    // Peer shares the causal base (as it would via the join snapshot).
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(session.doc));

    session.applyExternalContent("new AI content");
    expect(session.getText()).toBe("new AI content");
    expect(emitted.length).toBeGreaterThan(0);

    for (const u of emitted) {
      const bytes = decodeUpdate(u);
      if (bytes) {
        Y.applyUpdate(peer, bytes);
      }
    }
    expect(peer.getText("content").toString()).toBe("new AI content");
  });

  it("no-ops when content is identical (no broadcast storms)", () => {
    const emitted: string[] = [];
    const session = new DocSession("p1", "f1", {
      onLocalUpdate: (_docId, update) => {
        emitted.push(update);
      },
    });
    session.seedLocal("same");
    expect(session.handleJoined()).toBe(true);
    session.applyExternalContent("same");
    expect(emitted).toHaveLength(0);
  });
});

describe("DocSessionManager cleanup", () => {
  it("retain() disposes only dropped docs", () => {
    const manager = new DocSessionManager();
    manager.getOrCreate("p1", "f1");
    manager.getOrCreate("p1", "f2");
    const disposed = manager.retain(new Set(["p1:f1"]));
    expect(disposed).toEqual(["p1:f2"]);
    expect(manager.size()).toBe(1);
    expect(manager.dispose("p1:nope")).toBe(false);
  });
});

describe("undo behavior (documented decision)", () => {
  it("single-user local undo still reverts the last local edit", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const undo = new Y.UndoManager(text);
    doc.transact(() => {
      text.insert(0, "hello");
    });
    undo.undo();
    expect(text.toString()).toBe("");
    undo.redo();
    expect(text.toString()).toBe("hello");
  });

  it("remote ops do not corrupt the doc when interleaved with undo", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "hello");
    const undo = new Y.UndoManager(text);
    // Remote op lands (origin-tagged, as the binding applies it).
    doc.transact(() => {
      text.insert(0, "XY");
    }, REMOTE_ORIGIN);
    expect(text.toString()).toBe("XYhello");
    // Default UndoManager pops the latest stack item; the doc stays valid
    // either way — this test pins "no corruption", not a specific winner.
    undo.undo();
    expect(["XYhello", "hello", "XY"].includes(text.toString())).toBe(true);
  });
});
