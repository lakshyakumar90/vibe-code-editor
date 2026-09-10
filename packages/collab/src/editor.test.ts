import { describe, expect, it } from "vitest";
import {
  editorDocId,
  parseEditorDocId,
} from "./editor.js";
import {
  base64ByteLength,
  decodeUpdate,
  encodeUpdate,
  parseEditorMessage,
} from "./editor-schemas.js";

describe("editorDocId", () => {
  it("is deterministic and scoped to project + file id", () => {
    expect(editorDocId("p1", "f1")).toBe("p1:f1");
    expect(editorDocId("p1", "f1")).toBe(editorDocId("p1", "f1"));
  });

  it("never collides across projects or files", () => {
    expect(editorDocId("p1", "f1")).not.toBe(editorDocId("p2", "f1"));
    expect(editorDocId("p1", "f1")).not.toBe(editorDocId("p1", "f2"));
  });

  it("round-trips through parseEditorDocId", () => {
    expect(parseEditorDocId("p1:f1")).toEqual(["p1", "f1"]);
    expect(parseEditorDocId("no-separator")).toBeNull();
    expect(parseEditorDocId(":f1")).toBeNull();
    expect(parseEditorDocId("p1:")).toBeNull();
  });
});

describe("parseEditorMessage", () => {
  it("accepts editor.join/leave, with optional state vector", () => {
    expect(
      parseEditorMessage({ type: "editor.join", projectId: "p", fileId: "f" })
        .ok,
    ).toBe(true);
    expect(
      parseEditorMessage({
        type: "editor.join",
        projectId: "p",
        fileId: "f",
        sv: "aGVsbG8=",
      }).ok,
    ).toBe(true);
    expect(
      parseEditorMessage({ type: "editor.leave", projectId: "p", fileId: "f" })
        .ok,
    ).toBe(true);
  });

  it("accepts editor.update with a well-formed docId", () => {
    const ok = parseEditorMessage({
      type: "editor.update",
      docId: "p:f",
      update: "aGVsbG8=",
    });
    expect(ok.ok).toBe(true);
    expect(
      parseEditorMessage({ type: "editor.update", docId: "nosep", update: "aGk=" })
        .ok,
    ).toBe(false);
  });

  it("accepts awareness with cursor and optional selection", () => {
    expect(
      parseEditorMessage({
        type: "editor.awareness",
        projectId: "p",
        fileId: "f",
        cursor: { lineNumber: 3, column: 7 },
      }).ok,
    ).toBe(true);
    expect(
      parseEditorMessage({
        type: "editor.awareness",
        projectId: "p",
        fileId: "f",
        cursor: { lineNumber: 0, column: 7 },
      }).ok,
    ).toBe(false);
  });

  it("accepts awareness with Yjs-anchored cursor and selection", () => {
    expect(
      parseEditorMessage({
        type: "editor.awareness",
        projectId: "p",
        fileId: "f",
        cursor: { lineNumber: 3, column: 7 },
        cursorRel: { client: 123, clock: 45, assoc: 0 },
        selection: {
          startLineNumber: 3,
          startColumn: 1,
          endLineNumber: 3,
          endColumn: 7,
        },
        selectionRel: {
          anchor: { client: 123, clock: 40, assoc: 0 },
          head: null,
        },
      }).ok,
    ).toBe(true);
  });

  it("rejects malformed anchors but keeps rel fields optional", () => {
    // No rel fields at all — absolute fallback, still valid.
    expect(
      parseEditorMessage({
        type: "editor.awareness",
        projectId: "p",
        fileId: "f",
        cursor: { lineNumber: 1, column: 1 },
      }).ok,
    ).toBe(true);
    // Negative client id is not a valid Yjs client.
    expect(
      parseEditorMessage({
        type: "editor.awareness",
        projectId: "p",
        fileId: "f",
        cursor: { lineNumber: 1, column: 1 },
        cursorRel: { client: -1, clock: 0, assoc: 0 },
      }).ok,
    ).toBe(false);
    // Smuggled identity alongside rel fields is still rejected.
    expect(
      parseEditorMessage({
        type: "editor.awareness",
        projectId: "p",
        fileId: "f",
        cursor: { lineNumber: 1, column: 1 },
        cursorRel: { client: 7, clock: 1, assoc: 0 },
        userId: "u-victim",
      }).ok,
    ).toBe(false);
  });

  it("rejects smuggled identity fields (strict mode)", () => {
    const result = parseEditorMessage({
      type: "editor.awareness",
      projectId: "p",
      fileId: "f",
      cursor: { lineNumber: 1, column: 1 },
      userId: "u-victim",
      displayName: "Victim",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown editor types without throwing", () => {
    const result = parseEditorMessage({ type: "editor.nuke" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.requestType).toBe("editor.nuke");
    }
  });
});

describe("base64 update helpers", () => {
  it("round-trips bytes in both runtimes (no Buffer)", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const encoded = encodeUpdate(bytes);
    expect(typeof encoded).toBe("string");
    expect(decodeUpdate(encoded)).toEqual(bytes);
    expect(base64ByteLength(encoded)).toBe(bytes.length);
  });

  it("rejects empty payloads", () => {
    expect(decodeUpdate("")).toBeNull();
  });
});
