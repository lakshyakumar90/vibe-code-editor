import { describe, expect, it } from "vitest";
import { DocSession } from "./doc-session";
import {
  getSessionText,
  isSessionReady,
  registerSession,
  unregisterSession,
} from "./session-registry";

describe("session-registry", () => {
  it("reports not-ready for unknown files", () => {
    expect(isSessionReady("p1", "ghost")).toBe(false);
    expect(getSessionText("p1", "ghost")).toBeUndefined();
  });

  it("gates readiness on the session state machine", () => {
    const session = new DocSession("p1", "f-reg");
    registerSession(session);
    try {
      // UNINITIALIZED / SYNCING sessions do not own the model yet.
      expect(isSessionReady("p1", "f-reg")).toBe(false);
      expect(getSessionText("p1", "f-reg")).toBeUndefined();
      session.seedLocal("hello");
      expect(isSessionReady("p1", "f-reg")).toBe(false);
      expect(session.handleJoined()).toBe(true);
      expect(isSessionReady("p1", "f-reg")).toBe(true);
      expect(getSessionText("p1", "f-reg")).toBe("hello");
    } finally {
      unregisterSession(session.docId);
    }
    expect(isSessionReady("p1", "f-reg")).toBe(false);
    expect(getSessionText("p1", "f-reg")).toBeUndefined();
  });

  it("scopes readiness to the exact project + file", () => {
    const session = new DocSession("p1", "f-scope");
    registerSession(session);
    try {
      expect(session.handleJoined()).toBe(true);
      expect(isSessionReady("p1", "f-scope")).toBe(true);
      expect(isSessionReady("p2", "f-scope")).toBe(false);
      expect(isSessionReady("p1", "other")).toBe(false);
    } finally {
      unregisterSession(session.docId);
    }
  });
});
