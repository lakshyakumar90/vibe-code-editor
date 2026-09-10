import { describe, expect, it } from "vitest";
import { PresenceStore } from "./presence.js";
import type { Presence } from "./protocol.js";

function makePresence(
  overrides: Partial<Presence> = {},
): Presence {
  return {
    userId: "u1",
    displayName: "Ada",
    avatar: null,
    projectId: "p1",
    connectionId: "c1",
    status: "online",
    lastActivity: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("PresenceStore", () => {
  it("upsert + list returns room snapshot", () => {
    const store = new PresenceStore();
    store.upsert(makePresence());
    store.upsert(makePresence({ connectionId: "c2", userId: "u2" }));
    expect(store.list("p1")).toHaveLength(2);
  });

  it("leave removes one connection and reports it", () => {
    const store = new PresenceStore();
    store.upsert(makePresence());
    store.upsert(makePresence({ connectionId: "c2", userId: "u2" }));
    const removed = store.leave("p1", "c1");
    expect(removed?.connectionId).toBe("c1");
    expect(store.list("p1")).toHaveLength(1);
  });

  it("removeConnection clears all rooms and returns removals for broadcast", () => {
    const store = new PresenceStore();
    store.upsert(makePresence({ projectId: "p1", connectionId: "c1" }));
    store.upsert(makePresence({ projectId: "p2", connectionId: "c1" }));
    const removed = store.removeConnection("c1");
    expect(removed).toHaveLength(2);
    expect(store.list("p1")).toHaveLength(0);
    expect(store.list("p2")).toHaveLength(0);
    expect(store.projectsOf("c1")).toHaveLength(0);
  });

  it("prevents duplicate sessions from creating inconsistent state", () => {
    const store = new PresenceStore();
    store.upsert(makePresence({ status: "online" }));
    // Same connection re-joining replaces rather than duplicates.
    store.upsert(makePresence({ status: "away" }));
    const list = store.list("p1");
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("away");
  });

  it("isolates projects", () => {
    const store = new PresenceStore();
    store.upsert(makePresence({ projectId: "p1", connectionId: "c1" }));
    expect(store.list("p2")).toHaveLength(0);
    expect(store.has("c1", "p2")).toBe(false);
    expect(store.has("c1", "p1")).toBe(true);
  });
});
