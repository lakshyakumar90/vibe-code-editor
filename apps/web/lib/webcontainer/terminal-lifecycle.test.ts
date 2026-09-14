/**
 * Mock-container lifecycle test — the closest executable approximation of
 * the in-browser WebContainer boundary available outside a browser.
 *
 * The REAL bundled shim (`public/vibe/git-shim.cjs`) runs as a child node
 * process with VIBE_GIT_DIR pointed at a temp dir (the "container FS").
 * The REAL sync pipeline (scan → diff → apply) then runs against that dir.
 * Only the transports are faked: container.fs/spawn become node:fs +
 * child_process, and the File API becomes a recording mock.
 *
 * Chain covered (mirrors the review gate):
 *   boot files → __ensure-snapshot → terminal edit → scan → File API
 *   → add/commit → status clean → DB-side edit → status/diff see it
 *   → restore → rescan converges → credential audit (.git/config clean)
 */
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyContainerDiff,
  diffContainerFiles,
  scanContainerFiles,
  type DbFileLite,
} from "./container-sync";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(HERE, "..", "..", "public", "vibe", "git-shim.cjs");
const HAS_BUNDLE = (() => {
  try {
    readFileSync(BUNDLE);
    return true;
  } catch {
    return false;
  }
})();

const runIf = HAS_BUNDLE ? it : it.skip;

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function shim(root: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [BUNDLE, ...args],
      {
        cwd: root,
        timeout: 30_000,
        env: {
          ...process.env,
          VIBE_GIT_DIR: root,
          VIBE_GIT_NAME: "Terminal Tester",
          VIBE_GIT_EMAIL: "tester@vibe.local",
          ...extraEnv,
        } as NodeJS.ProcessEnv,
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          reject(error);
          return;
        }
        resolve({ code: (error as { code?: number })?.code ?? 0, out: String(stdout), err: String(stderr) });
      },
    );
  });
}

interface DirEntLike {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

async function scanRoot(root: string): Promise<Map<string, string>> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  return scanContainerFiles(
    async (dir): Promise<DirEntLike[]> => {
      const entries = await readdir(dir === "" ? root : path.join(root, ...dir.split("/")), { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
    },
    async (file): Promise<string | null> => {
      const abs = path.join(root, ...file.split("/"));
      try {
        const st = await stat(abs);
        if (!st.isFile()) return null;
        return await readFile(abs, "utf8");
      } catch {
        return null;
      }
    },
  );
}

function makeDb(): { rows: DbFileLite[]; calls: { post: unknown[]; put: unknown[]; del: string[] }; api: { post<T>(url: string, body: unknown): Promise<T>; put<T>(url: string, body: unknown): Promise<T>; delete(url: string): Promise<unknown> } } {
  const calls = { post: [] as unknown[], put: [] as unknown[], del: [] as string[] };
  let seq = 100;
  const rows: DbFileLite[] = [
    { id: "f-app", path: "src/app.ts", content: "export const v = 1;\n", isFolder: false },
    { id: "d-src", path: "src", content: null, isFolder: true },
  ];
  const api = {
    post: async <T>(url: string, body: unknown): Promise<T> => {
      calls.post.push({ url, body });
      const b = body as { name: string; parentId: string | null; isFolder: boolean; content?: string };
      const created = { id: `new-${seq++}` };
      if (b.isFolder) {
        const parent = rows.find((r) => r.id === b.parentId);
        const p = parent && !parent.isFolder ? "" : (parent ? `${parent.path}/` : "");
        rows.push({ id: created.id, path: `${p}${b.name}`, content: null, isFolder: true });
        return created as T;
      }
      const parent = rows.find((r) => r.id === b.parentId);
      const p = parent ? `${parent.path}/` : "";
      rows.push({ id: created.id, path: `${p}${b.name}`, content: b.content ?? "", isFolder: false });
      return created as T;
    },
    put: async <T>(url: string, body: unknown): Promise<T> => {
      calls.put.push({ url, body });
      const id = url.split("/").pop()!;
      const row = rows.find((r) => r.id === id)!;
      row.content = (body as { content: string }).content;
      return row as T;
    },
    delete: async (url: string): Promise<unknown> => {
      calls.del.push(url);
      const id = url.split("/").pop()!;
      const i = rows.findIndex((r) => r.id === id);
      if (i !== -1) rows.splice(i, 1);
      return {};
    },
  };
  return { rows, calls, api };
}

describe("terminal git lifecycle (mock container, real bundle)", () => {
  runIf("boot → snapshot → terminal edit reaches the File API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibe-lifecycle-"));
    try {
      // 1. "mount": project files land in the container.
      write(root, "src/app.ts", "export const v = 1;\n");
      write(root, "package.json", '{ "name": "demo" }\n');

      // 2. Boot-time Strategy-A snapshot.
      const snap = await shim(root, ["__ensure-snapshot"]);
      expect(snap.code).toBe(0);
      const log = await shim(root, ["log", "--oneline"]);
      expect(log.code).toBe(0);
      expect(log.out).toContain("Initial workspace snapshot");

      // 3. Terminal edit: echo "hello" > terminal-test.txt
      write(root, "terminal-test.txt", "hello\n");
      // Pollute metadata dirs: must never leak into the diff.
      write(root, ".git/pollution.txt", "junk\n");
      write(root, ".vibe/pollution.txt", "junk\n");
      write(root, "node_modules/dep/index.js", "junk\n");

      const { rows, calls, api } = makeDb();
      rows.push({ id: "f-pkg", path: "package.json", content: '{ "name": "demo" }\n', isFolder: false });
      const snapshot = await scanRoot(root);
      expect(snapshot.has(".git/pollution.txt")).toBe(false);
      expect(snapshot.has(".vibe/pollution.txt")).toBe(false);
      expect(snapshot.has("node_modules/dep/index.js")).toBe(false);
      expect(snapshot.get("terminal-test.txt")).toBe("hello\n");

      const diff = diffContainerFiles(snapshot, rows);
      expect(diff.created.map((c) => c.path)).toContain("terminal-test.txt");
      expect(diff.created.some((c) => c.path.startsWith(".git"))).toBe(false);
      const applied = await applyContainerDiff(api, "p1", rows, diff);
      expect(applied.changedPaths).toContain("terminal-test.txt");
      expect(calls.post.some((c) => JSON.stringify(c).includes("terminal-test.txt"))).toBe(true);

      // 4. git add + commit from the "terminal", then clean status.
      expect((await shim(root, ["add", "terminal-test.txt"])).code).toBe(0);
      const commit = await shim(root, ["commit", "-m", "terminal test"]);
      expect(commit.code).toBe(0);
      expect(commit.out).toMatch(/\[main [0-9a-f]{7}\] terminal test/);
      const status = await shim(root, ["status", "-s"]);
      expect(status.code).toBe(0);
      expect(status.out.trim()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  runIf("DB-side edit is visible to terminal git; restore converges", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibe-lifecycle-"));
    try {
      write(root, "src/app.ts", "export const v = 1;\n");
      expect((await shim(root, ["__ensure-snapshot"])).code).toBe(0);

      // 5. "Monaco" edit mirrored to the container (existing DB→container path).
      write(root, "src/app.ts", "export const v = 2;\n");
      const status = await shim(root, ["status", "-s"]);
      expect(status.out).toContain("M src/app.ts");
      const diff = await shim(root, ["diff", "--", "src/app.ts"]);
      expect(diff.out).toContain("-export const v = 1;");
      expect(diff.out).toContain("+export const v = 2;");

      // 6. git restore → rescan converges back to DB content.
      expect((await shim(root, ["restore", "src/app.ts"])).code).toBe(0);
      const { rows, api } = makeDb();
      const snapshot = await scanRoot(root);
      const d = diffContainerFiles(snapshot, rows);
      // DB still has v=1 and the container is back to v=1: no update needed.
      expect(d.updated.filter((u) => u.path === "src/app.ts")).toHaveLength(0);
      const applied = await applyContainerDiff(api, "p1", rows, d);
      expect(applied.changedPaths.filter((p) => p === "src/app.ts")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  runIf("credential audit: poisoned env never lands in git config/remote output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibe-lifecycle-"));
    const poison = {
      GITHUB_TOKEN: "ghp_super_secret_token",
      GH_TOKEN: "ghp_super_secret_token",
      ACCESS_TOKEN: "super_secret_token",
      DATABASE_URL: "postgres://secret",
      BETTER_AUTH_SECRET: "secret",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "Bearer super_secret_token",
    };
    try {
      write(root, "a.txt", "x\n");
      expect((await shim(root, ["__ensure-snapshot"], poison)).code).toBe(0);
      expect((await shim(root, ["remote", "add", "origin", "https://github.com/acme/demo.git"], poison)).code).toBe(0);
      const rv = await shim(root, ["remote", "-v"], poison);
      expect(rv.out).toContain("https://github.com/acme/demo.git");
      expect(rv.out).not.toContain("super_secret_token");
      expect(rv.out).not.toContain("ghp_");
      const cfg = await shim(root, ["config", "--list"], poison);
      expect(cfg.out).not.toContain("super_secret_token");
      const gitConfig = readFileSync(path.join(root, ".git", "config"), "utf8");
      expect(gitConfig).not.toContain("super_secret_token");
      expect(gitConfig).not.toContain("ghp_");
      expect(gitConfig).toContain("https://github.com/acme/demo.git");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
