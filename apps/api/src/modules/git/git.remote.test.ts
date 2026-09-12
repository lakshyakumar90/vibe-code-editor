import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real git transport (spawns ~seconds each on Windows); generous budget.
vi.setConfig({ testTimeout: 120000 });
import { isValidBranchName } from "./git.paths";
import { GitError } from "./git.errors";
import {
  assertSafeRemoteUrl,
  checkoutTracking,
  cloneRepo,
  commitFileChanges,
  commitMeta,
  fetchOrigin,
  getCloneMarker,
  getRemoteUrl,
  gitAuthEnv,
  historyFileDiff,
  listBranches,
  logCommits,
  mergeFastForward,
  parseRenamePaths,
  pushBranch,
  sanitizeRemoteMessage,
  setCloneMarker,
  setSparseRoot,
  tryRevparse,
  validateBranchRef,
  withRemoteTimeout,
  CLONE_MARKER_VALUE,
  classifyTransportError,
} from "./git.remote";
import { simpleGit } from "simple-git";

/**
 * Phase 4B — remote engine tests. Pure-function units plus REAL git
 * transport against local bare repositories (no network, no GitHub).
 * Auth env is empty for local paths; credential plumbing is asserted
 * structurally (gitAuthEnv shape, no persistence).
 */

vi.setConfig({ testTimeout: 90000 });

const dirs: string[] = [];

async function freshDir(prefix: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
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

/** A bare repo acting as "origin", seeded with one commit on main. */
async function seedBareOrigin(): Promise<{ bare: string; work: string }> {
  const bare = await freshDir("vibe-origin-");
  const work = await freshDir("vibe-seed-");
  const g = simpleGit({ baseDir: work });
  await g.init(["-b", "main"]);
  await g.addConfig("user.name", "T");
  await g.addConfig("user.email", "t@x.com");
  await write(work, "README.md", "# seed\n");
  await write(work, "src/app.ts", "export const a = 1;\n");
  await g.add(["-A"]);
  await g.commit("seed");
  const bareInit = simpleGit({ baseDir: work });
  await bareInit.raw(["init", "--bare", bare]);
  // A bare `git init` leaves HEAD pointing at nonexistent master; point it
  // at main like a real GitHub remote would, or clones check out nothing.
  await bareInit.raw(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await g.addRemote("origin", bare);
  await g.push("origin", "main");
  return { bare, work };
}

describe("pure helpers", () => {
  it("isValidBranchName rejects hostile names", () => {
    for (const good of ["main", "feature/auth", "release-1.0", "a/b/c", "x.y_z"]) {
      expect(isValidBranchName(good), good).toBe(true);
    }
    for (const bad of [
      "", "../main", "../../foo", "refs/heads/x", "-control", "foo..bar", "foo@",
      "foo@{1}", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", ".hidden",
      "a/.b", "a.lock", "a/", "/a", "a//b", "HEAD", "a\\b", "-",
    ]) {
      expect(isValidBranchName(bad), String(bad)).toBe(false);
    }
  });

  it("gitAuthEnv carries credentials process-only, never persisted", () => {
    const env = gitAuthEnv("tok123");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GIT_CONFIG_COUNT"]).toBe("1");
    expect(env["GIT_CONFIG_KEY_0"]).toBe("http.extraHeader");
    expect(env["GIT_CONFIG_VALUE_0"]).toBe("Authorization: Bearer tok123");
    expect(gitAuthEnv(null)).toEqual({ GIT_TERMINAL_PROMPT: "0" });
  });

  it("sanitizeRemoteMessage redacts credential shapes", () => {
    expect(sanitizeRemoteMessage("Bearer abc.def-ghi_jkl")).toContain("Bearer [redacted]");
    expect(sanitizeRemoteMessage("token ghp_abc123XYZ")).toContain("[redacted]");
    expect(sanitizeRemoteMessage("https://user:pass@github.com/o/r.git")).toContain("https://[redacted]@");
    expect(sanitizeRemoteMessage("https://github.com/o/r.git")).toContain("https://github.com/o/r.git");
  });

  it("assertSafeRemoteUrl allows https/file/local only", () => {
    expect(assertSafeRemoteUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(assertSafeRemoteUrl("file:///tmp/r.git")).toBe("file:///tmp/r.git");
    expect(assertSafeRemoteUrl("/tmp/r.git")).toBe("/tmp/r.git");
    for (const bad of ["git@github.com:o/r.git", "ssh://h/r.git", "ext::sh -c x", "", "https://", "http://h/r.git"]) {
      expect(() => assertSafeRemoteUrl(bad), String(bad)).toThrow(GitError);
    }
  });

  it("parseRenamePaths handles git rename spellings", () => {
    expect(parseRenamePaths("old.ts => new.ts")).toEqual({ oldPath: "old.ts", path: "new.ts" });
    expect(parseRenamePaths("{old.ts => new.ts}")).toEqual({ oldPath: "old.ts", path: "new.ts" });
    expect(parseRenamePaths("dir/{old.ts => new.ts}")).toEqual({ oldPath: "dir/old.ts", path: "dir/new.ts" });
    expect(parseRenamePaths("plain.ts")).toEqual({ path: "plain.ts" });
  });

  it("classifyTransportError maps deterministically without secrets", () => {
    expect(classifyTransportError("push", new Error("Authentication failed, Bearer xyz")).code).toBe(
      "GIT_GITHUB_REAUTH_REQUIRED",
    );
    expect(classifyTransportError("push", new Error('[rejected] main -> main (non-fast-forward)')).code).toBe(
      "GIT_PUSH_REJECTED",
    );
    expect(classifyTransportError("push", new Error("remote: Permission to o/r denied to u."))).toBeDefined();
    expect(classifyTransportError("pull", new Error("Not possible to fast-forward, aborting."))).toMatchObject({
      code: "GIT_PULL_DIVERGED",
    });
    expect(classifyTransportError("fetch", new Error("Could not resolve host: github.com"))).toMatchObject({
      code: "GIT_REMOTE_UNAVAILABLE",
    });
    expect(classifyTransportError("fetch", new Error("weird")).code).toBe("GIT_OPERATION_FAILED");
    const leaked = classifyTransportError("push", new Error("Bearer tok fetch https://u:p@h/r"));
    expect(JSON.stringify(leaked)).not.toMatch(/tok|u:p@/);
  });

  it("withRemoteTimeout rejects slow operations", async () => {
    await expect(
      withRemoteTimeout("test", () => new Promise(() => undefined), 20),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_TIMEOUT" });
    await expect(withRemoteTimeout("test", async () => 42, 1000)).resolves.toBe(42);
  });
});

describe("clone + sparse + marker", () => {
  it("clones a bare remote and records the marker", async () => {
    const { bare } = await seedBareOrigin();
    const dir = await freshDir("vibe-clone-");
    await fs.promises.rm(dir, { recursive: true, force: true });
    await cloneRepo(bare, dir, gitAuthEnv(null));
    await setCloneMarker(dir);
    expect(await getCloneMarker(dir)).toBe(CLONE_MARKER_VALUE);
    expect(await getRemoteUrl(dir)).toBe(bare);
    expect(await tryRevparse(dir, "HEAD")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("sparse cone restricts the worktree to the import root", async () => {
    const { bare } = await seedBareOrigin();
    const dir = await freshDir("vibe-sparse-");
    await fs.promises.rm(dir, { recursive: true, force: true });
    await cloneRepo(bare, dir, gitAuthEnv(null));
    await setSparseRoot(dir, "src");
    expect(await fs.promises.stat(path.join(dir, "src", "app.ts")).then((s) => s.isFile())).toBe(true);
    expect(await fs.promises.stat(path.join(dir, "README.md")).catch(() => null)).toBeNull();
  });

  it("no marker on plain repos", async () => {
    const dir = await freshDir("vibe-plain-");
    const g = simpleGit({ baseDir: dir });
    await g.init(["-b", "main"]);
    expect(await getCloneMarker(dir)).toBeNull();
    await setCloneMarker(dir);
    expect(await getCloneMarker(dir)).toBe(CLONE_MARKER_VALUE);
  });
});

describe("branches", () => {
  async function repoWithBranches(): Promise<string> {
    const { bare } = await seedBareOrigin();
    const dir = await freshDir("vibe-br-");
    await fs.promises.rm(dir, { recursive: true, force: true });
    await cloneRepo(bare, dir, gitAuthEnv(null));
    await setCloneMarker(dir);
    return dir;
  }

  it("lists local + remote branches with current marked", async () => {
    const dir = await repoWithBranches();
    const g = simpleGit({ baseDir: dir });
    await g.checkoutLocalBranch("feature/x");
    const list = await listBranches(dir);
    const local = list.filter((b) => !b.remote).map((b) => b.name);
    expect(local).toContain("main");
    expect(local).toContain("feature/x");
    expect(list.find((b) => b.name === "feature/x")?.current).toBe(true);
    expect(list.some((b) => b.remote && b.remoteName === "origin/main")).toBe(true);
  });

  it("validateBranchRef defers to git", async () => {
    const dir = await repoWithBranches();
    await validateBranchRef(dir, "feature/ok");
    await expect(validateBranchRef(dir, "../evil")).rejects.toMatchObject({ code: "GIT_INVALID_BRANCH" });
  });

  it("checkoutTracking creates a local tracking branch", async () => {
    const { bare } = await seedBareOrigin();
    // Add a remote-only branch to origin.
    const work = await freshDir("vibe-seed3-");
    const seed = simpleGit({ baseDir: work });
    await seed.clone(bare, work + "/c");
    const c = simpleGit({ baseDir: work + "/c" });
    await c.checkoutLocalBranch("remote-only");
    await write(work + "/c", "extra.txt", "x");
    await c.add(["-A"]);
    await c.commit("extra");
    await c.push("origin", "remote-only");
    const dir = await freshDir("vibe-track-");
    await fs.promises.rm(dir, { recursive: true, force: true });
    await cloneRepo(bare, dir, gitAuthEnv(null));
    await checkoutTracking(dir, "remote-only", "remote-only");
    const list = await listBranches(dir);
    expect(list.some((b) => !b.remote && b.name === "remote-only" && b.current)).toBe(true);
  });
});

describe("fetch / ahead-behind / pull / push over local transport", () => {
  it("fetch updates refs without touching the worktree; ahead/behind follows", async () => {
    const { bare, work } = await seedBareOrigin();
    const dir = await freshDir("vibe-ff-");
    await fs.promises.rm(dir, { recursive: true, force: true });
    await cloneRepo(bare, dir, gitAuthEnv(null));
    // Advance origin.
    const seed = simpleGit({ baseDir: work });
    await write(work, "remote.txt", "from-remote");
    await seed.add(["-A"]);
    await seed.commit("remote advance");
    await seed.push("origin", "main");
    // Worktree untouched before fetch.
    const before = await fs.promises.readFile(path.join(dir, "README.md"), "utf8");
    expect(before).toBe("# seed\n");
    await fetchOrigin(dir, gitAuthEnv(null));
    expect(await fs.promises.stat(path.join(dir, "remote.txt")).catch(() => null)).toBeNull();
    // The remote-tracking ref moved while the worktree did not.
    const localHead = await tryRevparse(dir, "HEAD");
    const remoteHead = await tryRevparse(dir, "origin/main");
    expect(localHead).not.toBe(remoteHead);
  });

  it("push sets upstream and fast-forward pull converges", async () => {
    const { bare, work: seedWork } = await seedBareOrigin();
    const dir = await freshDir("vibe-push-");
    await fs.promises.rm(dir, { recursive: true, force: true });
    await cloneRepo(bare, dir, gitAuthEnv(null));
    const g = simpleGit({ baseDir: dir });
    await g.addConfig("user.name", "T");
    await g.addConfig("user.email", "t@x.com");
    await g.checkoutLocalBranch("feature/pushme");
    await write(dir, "feat.txt", "work");
    await g.add(["-A"]);
    await g.commit("feat");
    await pushBranch(dir, "feature/pushme", true, gitAuthEnv(null));
    // Server side sees the branch now.
    const check = simpleGit({ baseDir: dir });
    const ls = await check.raw(["ls-remote", bare, "refs/heads/feature/pushme"]);
    expect(ls).toContain("refs/heads/feature/pushme");
    // Advance remote again, then ff-pull from a second clone.
    const dir2 = await freshDir("vibe-pull-");
    await fs.promises.rm(dir2, { recursive: true, force: true });
    await cloneRepo(bare, dir2, gitAuthEnv(null));
    const g2 = simpleGit({ baseDir: dir2 });
    await g2.checkout(["-b", "feature/pushme", "--track", "origin/feature/pushme"]);
    await write(seedWork, "more.txt", "m");
    const seed = simpleGit({ baseDir: seedWork });
    await seed.add(["-A"]);
    await seed.commit("more");
    await seed.push("origin", "main");
    // Upstream of feature/pushme is origin/feature/pushme (no advance) — pull is a no-op success.
    await fetchOrigin(dir2, gitAuthEnv(null));
    const merged = await mergeFastForward(dir2, "origin/feature/pushme");
    expect(merged.updated).toBe(false);
    void g;
  });

  it("non-fast-forward push is rejected, never forced", async () => {
    const { bare } = await seedBareOrigin();
    const mkClone = async (tag: string) => {
      const dir = await freshDir(`vibe-div-${tag}-`);
      await fs.promises.rm(dir, { recursive: true, force: true });
      await cloneRepo(bare, dir, gitAuthEnv(null));
      const g = simpleGit({ baseDir: dir });
      await g.addConfig("user.name", "T");
      await g.addConfig("user.email", "t@x.com");
      return { dir, g };
    };
    const a = await mkClone("a");
    const b = await mkClone("b");
    await write(a.dir, "a.txt", "a");
    await a.g.add(["-A"]);
    await a.g.commit("a-commit");
    await pushBranch(a.dir, "main", false, gitAuthEnv(null));
    await write(b.dir, "b.txt", "b");
    await b.g.add(["-A"]);
    await b.g.commit("b-commit");
    await expect(pushBranch(b.dir, "main", false, gitAuthEnv(null))).rejects.toMatchObject({
      code: "GIT_PUSH_REJECTED",
    });
    // And the failed push left no force flag anywhere in the call path.
    const src = await fs.promises.readFile(
      "C:/Lakshya/vibe-code-editor/apps/api/src/modules/git/git.remote.ts",
      "utf8",
    );
    expect(src).not.toMatch(/--force/);
  });
});

describe("history", () => {
  async function historyRepo(): Promise<string> {
    const dir = await freshDir("vibe-hist-");
    const g = simpleGit({ baseDir: dir });
    await g.init(["-b", "main"]);
    await g.addConfig("user.name", "Hist Author");
    await g.addConfig("user.email", "hist@example.com");
    await write(dir, "a.txt", "one\n");
    await g.add(["-A"]);
    await g.commit("first commit");
    await write(dir, "a.txt", "one\ntwo\n");
    await write(dir, "b.txt", "bee\n");
    await g.add(["-A"]);
    await g.commit("second commit");
    return dir;
  }

  it("logCommits orders newest-first with cursor pagination", async () => {
    const dir = await historyRepo();
    const log = logCommits;
    const page1 = await log(dir, "main", 1, null);
    expect(page1).toHaveLength(1);
    expect(page1[0]?.message).toBe("second commit");
    expect(page1[0]?.shortSha).toBe(page1[0]?.sha.slice(0, 7));
    expect(page1[0]?.parents).toHaveLength(1);
    const page2 = await log(dir, "main", 10, page1[0]?.sha ?? null);
    expect(page2.map((c) => c.message)).toEqual(["first commit"]);
    expect(page2[0]?.parents).toEqual([]);
  });

  it("commitMeta + commitFileChanges describe a commit", async () => {
    const dir = await historyRepo();
    const [head] = await logCommits(dir, "main", 1, null);
    const m = await commitMeta(dir, head!.sha);
    expect(m.authorName).toBe("Hist Author");
    expect(m.message).toBe("second commit");
    const f = await commitFileChanges(dir, head!.sha);
    expect(f.parents).toHaveLength(1);
    const byPath = new Map(f.files.map((x) => [x.path, x]));
    expect(byPath.get("a.txt")).toMatchObject({ status: "modified", additions: 1, deletions: 0, binary: false });
    expect(byPath.get("b.txt")).toMatchObject({ status: "added" });
    await expect(commitMeta(dir, "0".repeat(40))).rejects.toMatchObject({ code: "GIT_COMMIT_NOT_FOUND" });
    await expect(commitMeta(dir, "not-a-sha")).rejects.toMatchObject({ code: "GIT_COMMIT_NOT_FOUND" });
  });

  it("historyFileDiff resolves parent→commit contents", async () => {
    const dir = await historyRepo();
    const [head] = await logCommits(dir, "main", 1, null);
    const d = await historyFileDiff(dir, head!.sha, "a.txt");
    expect(d.oldContent).toBe("one\n");
    expect(d.newContent).toBe("one\ntwo\n");
    expect(d.isBinary).toBe(false);
    const added = await historyFileDiff(dir, head!.sha, "b.txt");
    expect(added.oldContent).toBeNull();
    expect(added.newContent).toBe("bee\n");
    await expect(historyFileDiff(dir, head!.sha, "nope.txt")).rejects.toMatchObject({ code: "GIT_INVALID_PATH" });
  });
});
