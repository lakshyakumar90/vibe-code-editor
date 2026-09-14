import { describe, expect, it } from "vitest";
import {
  diffContainerFiles,
  looksBinary,
  shouldSyncPath,
  type DbFileLite,
} from "./container-sync";

function db(files: { path: string; content?: string; isFolder?: boolean }[]): DbFileLite[] {
  return files.map((f, i) => ({
    id: `id-${i}`,
    path: f.path,
    content: f.isFolder ? null : (f.content ?? ""),
    isFolder: f.isFolder ?? false,
  }));
}

describe("shouldSyncPath", () => {
  it("allows normal project files", () => {
    expect(shouldSyncPath("src/App.tsx")).toBe(true);
    expect(shouldSyncPath("package.json")).toBe(true);
  });

  it("excludes git metadata and runtime dirs", () => {
    expect(shouldSyncPath(".git/HEAD")).toBe(false);
    expect(shouldSyncPath(".git")).toBe(false);
    expect(shouldSyncPath(".vibe/git-shim.cjs")).toBe(false);
    expect(shouldSyncPath("node_modules/react/index.js")).toBe(false);
    expect(shouldSyncPath(".next/static/chunk.js")).toBe(false);
    expect(shouldSyncPath("dist/bundle.js")).toBe(false);
  });

  it("excludes traversals and empties", () => {
    expect(shouldSyncPath("../evil.ts")).toBe(false);
    expect(shouldSyncPath("")).toBe(false);
  });

  it("does not exclude a project .gitignore file itself", () => {
    expect(shouldSyncPath(".gitignore")).toBe(true);
  });
});

describe("looksBinary", () => {
  it("sniffs NUL bytes", () => {
    expect(looksBinary("hello")).toBe(false);
    expect(looksBinary("a\0b")).toBe(true);
  });
});

describe("diffContainerFiles", () => {
  it("detects creates, updates, deletes", () => {
    const diff = diffContainerFiles(
      new Map([
        ["keep.ts", "same"],
        ["edit.ts", "new"],
        ["fresh.ts", "hi"],
      ]),
      db([
        { path: "keep.ts", content: "same" },
        { path: "edit.ts", content: "old" },
        { path: "gone.ts", content: "x" },
      ]),
    );
    expect(diff.created.map((c) => c.path)).toEqual(["fresh.ts"]);
    expect(diff.updated.map((u) => u.path)).toEqual(["edit.ts"]);
    expect(diff.deleted.map((d) => d.path)).toEqual(["gone.ts"]);
  });

  it("returns empty for an empty container snapshot (remount safety)", () => {
    const diff = diffContainerFiles(new Map(), db([{ path: "a.ts", content: "x" }]));
    expect(diff).toEqual({ created: [], updated: [], deleted: [] });
  });

  it("drops mass deletions", () => {
    const rows = db([
      { path: "a.ts", content: "1" },
      { path: "b.ts", content: "2" },
      { path: "c.ts", content: "3" },
      { path: "d.ts", content: "4" },
    ]);
    const diff = diffContainerFiles(new Map([["a.ts", "1"]]), rows);
    expect(diff.deleted).toEqual([]);
  });
});
