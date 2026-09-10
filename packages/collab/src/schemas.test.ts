import { describe, expect, it } from "vitest";
import { parseClientMessage, safeJsonParse } from "./schemas.js";

describe("parseClientMessage", () => {
  it("accepts project.join", () => {
    const result = parseClientMessage({ type: "project.join", projectId: "p1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual({ type: "project.join", projectId: "p1" });
    }
  });

  it("accepts project.leave", () => {
    expect(
      parseClientMessage({ type: "project.leave", projectId: "p1" }).ok,
    ).toBe(true);
  });

  it("accepts presence.update with online/away", () => {
    expect(
      parseClientMessage({
        type: "presence.update",
        projectId: "p1",
        status: "away",
      }).ok,
    ).toBe(true);
    expect(
      parseClientMessage({
        type: "presence.update",
        projectId: "p1",
        status: "busy",
      }).ok,
    ).toBe(false);
  });

  it("accepts ping", () => {
    expect(parseClientMessage({ type: "ping", ts: 123 }).ok).toBe(true);
  });

  it("rejects unknown message types without throwing", () => {
    const result = parseClientMessage({ type: "editor.update", foo: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.requestType).toBe("editor.update");
    }
  });

  it("rejects missing projectId", () => {
    const result = parseClientMessage({ type: "project.join" });
    expect(result.ok).toBe(false);
  });

  it("rejects non-objects and preserves requestType when present", () => {
    expect(parseClientMessage(null).ok).toBe(false);
    expect(parseClientMessage("hello").ok).toBe(false);
    const result = parseClientMessage({ type: "ping" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.requestType).toBe("ping");
    }
  });

  it("rejects strict-mode extra keys (impersonation fields stripped at schema level)", () => {
    // A client attempting to sneak userId into the payload must be rejected,
    // forcing the server-authoritative identity path.
    const result = parseClientMessage({
      type: "project.join",
      projectId: "p1",
      userId: "attacker-target",
    });
    expect(result.ok).toBe(false);
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns undefined for malformed JSON", () => {
    expect(safeJsonParse("{not json")).toBeUndefined();
  });
});
