import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real git spawns (~2s/op on Windows); parallel suites starve the default
// 5s timeout. Generous per-test budget here only — unit suites stay fast.
vi.setConfig({ testTimeout: 90000 });
import {
  commitAllowEmpty,
  commitStaged,
  currentBranch,
  discardPaths,
  diffFile,
  getStatus,
  initRepo,
  revparseHead,
  stageAll,
  stagePaths,
  unstageAll,
  unstagePaths,
  type EngineStatus,
} from "./git.engine";
import { GitError } from "./git.errors";

/**
 * Phase 4A — engine tests against REAL git (2.45 available in this env)
 * in temp dirs. No mocks: validates status mapping, rename detection,
 * staged/unstaged splits, diffs, discard, and commits end to end.
 */

const IDENTITY = { name: "Test User", email: "test@example.com" };
const dirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vibe-git-eng-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function write(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content, "utf8");
}

describe("init / branch / head", () => {
  it("initializes on the requested branch with unborn HEAD", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    expect(await revparseHead(dir)).toBeNull();
    expect(await currentBranch(dir)).toBe("main");
  });

  it("rejects hostile branch names", async () => {
    const dir = await freshDir();
    await expect(initRepo(dir, "../evil", null, IDENTITY)).rejects.toBeInstanceOf(GitError);
    await expect(initRepo(dir, "-b trick", null, IDENTITY)).rejects.toBeInstanceOf(GitError);
  });
});

describe("status mapping", () => {
  it("clean / modified / added / deleted / untracked / staged+unstaged", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await write(dir, "tracked.txt", "v1");
    await write(dir, "gone.txt", "bye");
    await stageAll(dir);
    await commitStaged(dir, "init", IDENTITY);

    // Untracked.
    await write(dir, "new-untracked.txt", "new");
    // Modified unstaged.
    await write(dir, "tracked.txt", "v2");
    // Deleted.
    await fs.promises.rm(path.join(dir, "gone.txt"));
    let status = await getStatus(dir);
    expect(status.clean).toBe(false);
    const byPath = new Map(status.entries.map((e) => [e.path, e]));
    expect(byPath.get("new-untracked.txt")).toMatchObject({ status: "untracked", staged: false, unstaged: true });
    expect(byPath.get("tracked.txt")).toMatchObject({ status: "modified", staged: false, unstaged: true });
    expect(byPath.get("gone.txt")).toMatchObject({ status: "deleted", staged: false, unstaged: true });

    // Stage one file: staged + unstaged split on further edit.
    await stagePaths(dir, ["tracked.txt"]);
    await write(dir, "tracked.txt", "v3");
    status = await getStatus(dir);
    const tracked = byPathUpdate(status, "tracked.txt");
    expect(tracked.staged).toBe(true);
    expect(tracked.unstaged).toBe(true);
    expect(tracked.status).toBe("modified");
  });

  it("detects renames with old/new paths", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await write(dir, "old.txt", "same-content-here-1234567890");
    await stageAll(dir);
    await commitStaged(dir, "init", IDENTITY);
    await stagePaths(dir, [] ).catch(() => undefined);
    const { simpleGit } = await import("simple-git");
    await simpleGit({ baseDir: dir }).mv("old.txt", "new.txt");
    const status = await getStatus(dir);
    const renamed = status.entries.find((e) => e.path === "new.txt");
    expect(renamed).toMatchObject({ status: "renamed", oldPath: "old.txt", staged: true });
  });

  it("staged-new file shows as added", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await write(dir, "a.txt", "x");
    await stageAll(dir);
    const status = await getStatus(dir);
    expect(status.entries.find((e) => e.path === "a.txt")).toMatchObject({
      status: "added",
      staged: true,
      unstaged: false,
    });
  });
});

function byPathUpdate(status: EngineStatus, p: string) {
  const found = status.entries.find((e) => e.path === p);
  if (!found) throw new Error(`missing ${p}`);
  return found;
}

describe("stage / unstage", () => {
  it("stageAll + unstageAll round-trip; unstagePaths is scoped", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await write(dir, "a.txt", "1");
    await write(dir, "b.txt", "2");
    await stageAll(dir);
    let status = await getStatus(dir);
    expect(status.entries.every((e) => e.staged)).toBe(true);
    await unstagePaths(dir, ["a.txt"]);
    status = await getStatus(dir);
    expect(status.entries.find((e) => e.path === "a.txt")?.staged).toBe(false);
    expect(status.entries.find((e) => e.path === "b.txt")?.staged).toBe(true);
    await unstageAll(dir);
    status = await getStatus(dir);
    expect(status.entries.some((e) => e.staged)).toBe(false);
  });
});

describe("diff", () => {
  it("working vs HEAD and staged vs HEAD with old/new contents", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await write(dir, "a.txt", "one\ntwo\n");
    await stageAll(dir);
    await commitStaged(dir, "init", IDENTITY);
    await write(dir, "a.txt", "one\nTWO\n");
    const unstaged = await diffFile(dir, "a.txt", false);
    expect(unstaged).toMatchObject({
      status: "modified",
      staged: false,
      isBinary: false,
      tooLarge: false,
      oldContent: "one\ntwo\n",
      newContent: "one\nTWO\n",
    });
    await stagePaths(dir, ["a.txt"]);
    await write(dir, "a.txt", "one\nTHREE\n");
    const staged = await diffFile(dir, "a.txt", true);
    expect(staged.newContent).toBe("one\nTWO\n");
    const working = await diffFile(dir, "a.txt", false);
    expect(working.newContent).toBe("one\nTHREE\n");
  });

  it("added file has null oldContent; deleted file has null newContent", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await write(dir, "new.txt", "fresh");
    const added = await diffFile(dir, "new.txt", false);
    expect(added.oldContent).toBeNull();
    expect(added.newContent).toBe("fresh");
    await stageAll(dir);
    await commitStaged(dir, "init", IDENTITY);
    await fs.promises.rm(path.join(dir, "new.txt"));
    const deleted = await diffFile(dir, "new.txt", false);
    expect(deleted.status).toBe("deleted");
    expect(deleted.oldContent).toBe("fresh");
    expect(deleted.newContent).toBeNull();
  });

  it("binary files report isBinary without contents", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await fs.promises.writeFile(path.join(dir, "img.bin"), Buffer.from([0x89, 0x50, 0x00, 0xff]));
    await stageAll(dir);
    await commitStaged(dir, "init", IDENTITY);
    await fs.promises.writeFile(path.join(dir, "img.bin"), Buffer.from([0x89, 0x50, 0x01, 0xfe]));
    const diff = await diffFile(dir, "img.bin", false);
    expect(diff.isBinary).toBe(true);
    expect(diff.oldContent).toBeNull();
    expect(diff.newContent).toBeNull();
  });

  it("clean path throws GIT_INVALID_PATH", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await write(dir, "a.txt", "x");
    await stageAll(dir);
    await commitStaged(dir, "init", IDENTITY);
    await expect(diffFile(dir, "a.txt", false)).rejects.toMatchObject({ code: "GIT_INVALID_PATH" });
  });
});

describe("discard", () => {
  it("restores tracked modifications and deleted files", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await write(dir, "a.txt", "v1");
    await write(dir, "gone.txt", "bye");
    await stageAll(dir);
    await commitStaged(dir, "init", IDENTITY);
    await write(dir, "a.txt", "v2");
    await fs.promises.rm(path.join(dir, "gone.txt"));
    const results = await discardPaths(dir, ["a.txt", "gone.txt"]);
    expect(results).toMatchObject([
      { path: "a.txt", outcome: "restored" },
      { path: "gone.txt", outcome: "restored" },
    ]);
    expect(await fs.promises.readFile(path.join(dir, "a.txt"), "utf8")).toBe("v1");
    expect(await fs.promises.readFile(path.join(dir, "gone.txt"), "utf8")).toBe("bye");
    expect((await getStatus(dir)).clean).toBe(true);
  });

  it("unstages and removes staged-new files", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await write(dir, "a.txt", "x");
    await stageAll(dir);
    await commitStaged(dir, "init", IDENTITY);
    await write(dir, "brand-new.txt", "hello");
    await stagePaths(dir, ["brand-new.txt"]);
    const results = await discardPaths(dir, ["brand-new.txt"]);
    expect(results).toMatchObject([{ path: "brand-new.txt", outcome: "removed" }]);
    expect(await fs.promises.stat(path.join(dir, "brand-new.txt")).catch(() => null)).toBeNull();
  });
});

describe("commit", () => {
  it("commits staged changes with identity and returns metadata", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await write(dir, "a.txt", "x");
    await stageAll(dir);
    const result = await commitStaged(dir, "  hello world  ", IDENTITY);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.message).toBe("hello world");
    expect(result.authorEmail).toBe("test@example.com");
    expect(result.timestamp).toBeTruthy();
    expect((await getStatus(dir)).clean).toBe(true);
  });

  it("rejects empty messages", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    await expect(commitStaged(dir, "   ", IDENTITY)).rejects.toMatchObject({
      code: "GIT_COMMIT_INVALID_MESSAGE",
    });
  });

  it("empty repo takes an explicit empty commit", async () => {
    const dir = await freshDir();
    await initRepo(dir, "main", null, IDENTITY);
    const result = await commitAllowEmpty(dir, "Import acme/demo@abc1234");
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await revparseHead(dir)).toBe(result.sha);
  });
});
