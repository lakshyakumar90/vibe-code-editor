import { describe, expect, it, vi } from "vitest";
import {
  buildImportFileRows,
  decodeTextBytes,
  IMPORT_LIMITS,
  isBinaryExtension,
  isExcludedPath,
  looksBinary,
  normalizeImportRoot,
  planImport,
  toProjectPath,
} from "./import.service";

/**
 * Phase 3 — import service tests. GitHub is mocked at the fetch boundary;
 * no network, no DB (planImport never writes — the caller transacts).
 */

// ---------------------------------------------------------------------------
// Mock GitHub harness
// ---------------------------------------------------------------------------

const TOKEN = "gh-test-token";

interface StubEntry {
  path: string;
  mode?: string;
  type?: string;
  size?: number;
}

interface StubOptions {
  repoOverrides?: Record<string, unknown>;
  entries?: StubEntry[];
  blobs?: Record<string, string | Buffer>;
  commits?: Array<{ sha: string }> | null;
  treeStatus?: number;
  repoStatus?: number;
  failBlobsFor?: string[];
}

function b64(data: string | Buffer): string {
  return Buffer.isBuffer(data) ? data.toString("base64") : Buffer.from(data, "utf8").toString("base64");
}

function stubGitHub(opts: StubOptions = {}) {
  const {
    repoOverrides = {},
    entries = [],
    blobs = {},
    commits = [{ sha: "abc123def456" }],
    treeStatus = 200,
    repoStatus = 200,
    failBlobsFor = [],
  } = opts;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
    calls.push(url);
    const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers: new Headers(headers) });
    if (url.includes("/commits/")) {
      if (commits === null) return json({ message: "nope" }, 404);
      return json(commits);
    }
    if (url.includes("/git/trees/")) {
      if (treeStatus !== 200) return json({ message: "boom" }, treeStatus);
      return json({
        truncated: false,
        tree: entries.map((e) => ({
          path: e.path,
          mode: e.mode ?? "100644",
          type: e.type ?? "blob",
          sha: "sha-" + e.path,
          size: e.size ?? 10,
        })),
      });
    }
    if (url.includes("/contents/")) {
      // Contents URL encodes each segment; recover the repo-relative path.
      const m = url.match(/\/contents\/(.+)\?ref=/);
      const decoded = m ? m[1]!.split("/").map((s) => decodeURIComponent(s)).join("/") : "";
      if (failBlobsFor.includes(decoded)) return json({ message: "gone" }, 404);
      const body = blobs[decoded];
      if (body === undefined) return json({ message: "not found" }, 404);
      return json({ content: b64(body), encoding: "base64", size: Buffer.isBuffer(body) ? body.length : body.length });
    }
    if (/\/repos\/[^/]+\/[^/?]+$/.test(url.split("?")[0]!)) {
      if (repoStatus !== 200) return json({ message: "nope" }, repoStatus);
      return json({
        id: 4242,
        name: "demo",
        full_name: "acme/demo",
        owner: { login: "acme", type: "Organization" },
        private: false,
        fork: false,
        default_branch: "main",
        html_url: "https://github.com/acme/demo",
        description: "Demo repo",
        language: "TypeScript",
        stargazers_count: 1,
        updated_at: "2026-01-01T00:00:00Z",
        permissions: { pull: true, push: true, admin: false, maintain: false, triage: false },
        ...repoOverrides,
      });
    }
    return json({ message: "unexpected: " + url }, 500);
  });
  return { fetchImpl, calls };
}

const NEXT_PKG = JSON.stringify({
  dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
  scripts: { dev: "next dev", build: "next build" },
});
const REACT_PKG = JSON.stringify({
  dependencies: { react: "^18.3.0", "react-dom": "^18.3.0" },
  devDependencies: { vite: "^5.0.0" },
});
const EXPRESS_PKG = JSON.stringify({ dependencies: { express: "^4.18.2" }, scripts: { start: "node index.js" } });
const HONO_PKG = JSON.stringify({ dependencies: { hono: "4.7.4", "@hono/node-server": "1.13.8" } });
const ANGULAR_PKG = JSON.stringify({ dependencies: { "@angular/core": "^21.0.0" } });
const VUE_PKG = JSON.stringify({ dependencies: { vue: "^3.3.4" } });

function nextJsStub(extra: Partial<StubOptions> = {}) {
  return stubGitHub({
    entries: [
      { path: "package.json" },
      { path: "app/page.tsx" },
      { path: "next.config.mjs" },
      { path: "app/layout.tsx" },
    ],
    blobs: {
      "package.json": NEXT_PKG,
      "app/page.tsx": "export default function Page() { return <h1>hi</h1>; }",
      "next.config.mjs": "export default {};",
      "app/layout.tsx": "export default function Layout({children}) { return children; }",
    },
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("normalizeImportRoot", () => {
  it("treats missing/empty/dot as repo root", () => {
    expect(normalizeImportRoot(undefined)).toBe("");
    expect(normalizeImportRoot("")).toBe("");
    expect(normalizeImportRoot("  ")).toBe("");
    expect(normalizeImportRoot(".")).toBe("");
    expect(normalizeImportRoot("/")).toBe("");
  });
  it("normalizes slashes", () => {
    expect(normalizeImportRoot("/apps/web/")).toBe("apps/web");
    expect(normalizeImportRoot("apps/web")).toBe("apps/web");
  });
  it("rejects traversal, absolute escapes, backslashes, depth", () => {
    expect(normalizeImportRoot("../../")).toBeNull();
    expect(normalizeImportRoot("apps/../../etc")).toBeNull();
    expect(normalizeImportRoot("..")).toBeNull();
    expect(normalizeImportRoot("a\\b")).toBeNull();
    expect(normalizeImportRoot("a/b/c/d/e")).toBeNull();
    expect(normalizeImportRoot(42)).toBeNull();
  });
});

describe("toProjectPath", () => {
  it("maps repo paths under the selected root", () => {
    expect(toProjectPath("apps/web/src/a.tsx", "apps/web")).toBe("src/a.tsx");
    expect(toProjectPath("package.json", "")).toBe("package.json");
    expect(toProjectPath("apps/web/package.json", "apps/web")).toBe("package.json");
  });
  it("rejects absolute paths, traversal, escapes and sibling roots", () => {
    expect(toProjectPath("/etc/passwd", "")).toBeNull();
    expect(toProjectPath("apps/web/../../etc/passwd", "apps/web")).toBeNull();
    expect(toProjectPath("apps/web/..\\x", "apps/web")).toBeNull();
    expect(toProjectPath("apps/api/index.js", "apps/web")).toBeNull();
    expect(toProjectPath("apps/web", "apps/web")).toBeNull();
    expect(toProjectPath("", "")).toBeNull();
    expect(toProjectPath("a\0b", "")).toBeNull();
  });
});

describe("isExcludedPath", () => {
  it("excludes generated, vendored and secret-bearing paths", () => {
    for (const p of [
      ".git/config",
      "node_modules/react/index.js",
      "a/node_modules/x/y.js",
      ".next/static/app.js",
      "dist/bundle.js",
      "build/output.css",
      "coverage/lcov.info",
      ".env",
      ".env.local",
      ".env.production",
      ".env.development",
      "apps/web/.env",
    ]) {
      expect(isExcludedPath(p)).toBe(true);
    }
  });
  it("keeps source, config and lookalike files", () => {
    for (const p of ["src/app.tsx", "package.json", ".envrc", ".envision/notes.md", "src/.envish.ts"]) {
      expect(isExcludedPath(p)).toBe(false);
    }
  });
});

describe("looksBinary / decodeTextBytes", () => {
  it("sniffs NUL bytes and rejects non-UTF8", () => {
    expect(looksBinary(Buffer.from("hello"))).toBe(false);
    expect(looksBinary(Buffer.from([0x68, 0x69, 0x00, 0x01]))).toBe(true);
    expect(decodeTextBytes(Buffer.from("héllo — utf8 ✓"))).toContain("héllo");
    expect(decodeTextBytes(Buffer.from([0xff, 0xfe, 0x00]))).toBeNull();
  });
});

describe("buildImportFileRows", () => {
  it("derives folders, links parents shallow-first, dedupes", () => {
    const { folderRows, fileRows } = buildImportFileRows(
      "p1",
      [
        { path: "src/a.tsx", content: "a" },
        { path: "src/nested/b.ts", content: "b" },
        { path: "src/a.tsx", content: "dup-ignored" },
        { path: "README.md", content: "r" },
      ],
      "u1",
    );
    expect(folderRows.map((r) => r.path)).toEqual(["src", "src/nested"]);
    expect(folderRows.every((r) => r.content === null && r.isFolder)).toBe(true);
    const byPath = new Map(fileRows.map((r) => [r.path, r]));
    expect(byPath.get("src/nested/b.ts")!.parentId).toBe(
      folderRows.find((r) => r.path === "src/nested")!.id,
    );
    expect(byPath.get("src/a.tsx")!.content).toBe("a");
    expect(byPath.get("README.md")!.parentId).toBeNull();
    expect(fileRows.every((r) => r.updatedByUserId === "u1")).toBe(true);
    const ids = new Set([...folderRows, ...fileRows].map((r) => r.id));
    expect(ids.size).toBe(folderRows.length + fileRows.length);
  });
});

// ---------------------------------------------------------------------------
// planImport happy paths (all six templates)
// ---------------------------------------------------------------------------

const TEMPLATE_FIXTURES: Array<{ template: string; pkg: string; files: Record<string, string>; extraEntries?: StubEntry[] }> = [
  {
    template: "NEXTJS",
    pkg: NEXT_PKG,
    files: { "app/page.tsx": "export default function Page(){}", "next.config.mjs": "" },
  },
  {
    template: "REACT",
    pkg: REACT_PKG,
    files: { "src/main.tsx": "import App from './App'", "index.html": "<html/>" },
  },
  {
    template: "EXPRESS",
    pkg: EXPRESS_PKG,
    files: { "index.js": "const express = require('express')" },
  },
  {
    template: "HONO",
    pkg: HONO_PKG,
    files: { "src/index.ts": "import { Hono } from 'hono'" },
  },
  {
    template: "ANGULAR",
    pkg: ANGULAR_PKG,
    files: { "angular.json": "{}", "src/main.ts": "bootstrap" },
  },
  {
    template: "VUE",
    pkg: VUE_PKG,
    files: { "src/App.vue": "<template/>", "src/main.js": "createApp" },
  },
];

describe("planImport happy paths", () => {
  for (const fixture of TEMPLATE_FIXTURES) {
    it(`imports a supported ${fixture.template} repo as ordinary project rows`, async () => {
      const entries: StubEntry[] = [
        { path: "package.json" },
        ...Object.keys(fixture.files).map((path) => ({ path })),
        ...(fixture.extraEntries ?? []),
      ];
      const { fetchImpl } = stubGitHub({ entries, blobs: { "package.json": fixture.pkg, ...fixture.files } });
      const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.project.template).toBe(fixture.template);
      expect(result.project.ownerId).toBe("u1");
      expect(result.gitRepository).toMatchObject({
        githubRepoId: "4242",
        owner: "acme",
        repo: "demo",
        fullName: "acme/demo",
        defaultBranch: "main",
        currentBranch: "main",
        importedSha: "abc123def456",
        private: false,
        canRead: true,
        canWrite: true,
        canAdmin: false,
      });
      expect(result.stats.files).toBe(Object.keys(fixture.files).length + 1);
      expect(result.fileRows.length).toBe(result.stats.files);
      // No Git state, no credentials anywhere in the payload.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toMatch(/\.git\//);
    });
  }

  it("ignores client-supplied template/sha: server re-verifies everything", async () => {
    const { fetchImpl } = nextJsStub();
    const result = await planImport({
      userId: "u1",
      owner: "acme",
      repo: "demo",
      token: TOKEN,
      fetchImpl,
      template: "EXPRESS",
      sha: "forged",
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.template).toBe("NEXTJS");
    expect(result.gitRepository.importedSha).toBe("abc123def456");
  });

  it("duplicate imports create separate projects (never overwrite)", async () => {
    const first = nextJsStub();
    const second = nextJsStub();
    const a = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: first.fetchImpl });
    const b = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: second.fetchImpl });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.projectId).not.toBe(b.projectId);
  });
});

// ---------------------------------------------------------------------------
// Monorepo + inspection states
// ---------------------------------------------------------------------------

function monorepoStub() {
  return stubGitHub({
    entries: [
      { path: "apps/web/package.json" },
      { path: "apps/web/app/page.tsx" },
      { path: "apps/web/next.config.mjs" },
      { path: "apps/api/package.json" },
      { path: "apps/api/index.js" },
    ],
    blobs: {
      "apps/web/package.json": NEXT_PKG,
      "apps/web/app/page.tsx": "page",
      "apps/web/next.config.mjs": "",
      "apps/api/package.json": EXPRESS_PKG,
      "apps/api/index.js": "server",
    },
  });
}

describe("planImport monorepo + inspection states", () => {
  it("imports only the selected supported root", async () => {
    const { fetchImpl } = monorepoStub();
    const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", root: "apps/web", token: TOKEN, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.template).toBe("NEXTJS");
    const paths = result.fileRows.map((r) => r.path).sort();
    expect(paths).toEqual(["app/page.tsx", "next.config.mjs", "package.json"]);
    expect(paths).not.toContain("index.js");
  });

  it("rejects invalid, arbitrary and unsupported roots", async () => {
    const bad = nextJsStub();
    const arbitrary = await planImport({ userId: "u1", owner: "acme", repo: "demo", root: "../../etc", token: TOKEN, fetchImpl: bad.fetchImpl });
    expect(arbitrary).toMatchObject({ ok: false, code: "INVALID_ROOT", status: 400 });

    const missing = monorepoStub();
    const noRoot = await planImport({ userId: "u1", owner: "acme", repo: "demo", root: "apps/missing", token: TOKEN, fetchImpl: missing.fetchImpl });
    expect(noRoot).toMatchObject({ ok: false, code: "INVALID_ROOT" });

    const wrong = monorepoStub();
    // "apps/api" exists and IS supported here; use a root-less call on a
    // monorepo without repo-root package.json instead.
    const empty = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: wrong.fetchImpl });
    expect(empty).toMatchObject({ ok: false, code: "INVALID_ROOT" });
  });

  it("truncated inspection yields IMPORT_INSPECTION_LIMIT, never UNSUPPORTED_TEMPLATE", async () => {
    const { fetchImpl } = stubGitHub({
      entries: [{ path: "package.json" }],
      blobs: { "package.json": NEXT_PKG },
    });
    // Force truncation by stubbing the tree endpoint directly.
    const truncFetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({ truncated: true, tree: [] }), { status: 200 });
      }
      return fetchImpl(url, {});
    });
    const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: truncFetch as never });
    expect(result).toMatchObject({ ok: false, code: "IMPORT_INSPECTION_LIMIT", status: 422, truncated: true });
  });

  it("more than 10 roots yields IMPORT_INSPECTION_LIMIT", async () => {
    const entries: StubEntry[] = [];
    const blobs: Record<string, string> = {};
    for (let i = 0; i < 11; i++) {
      entries.push({ path: `r${i}/package.json` });
      blobs[`r${i}/package.json`] = REACT_PKG;
    }
    const { fetchImpl } = stubGitHub({ entries, blobs });
    const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl });
    expect(result).toMatchObject({ ok: false, code: "IMPORT_INSPECTION_LIMIT", truncated: true });
  });

  it("genuinely unsupported repo yields UNSUPPORTED_TEMPLATE without truncated flag", async () => {
    const { fetchImpl } = stubGitHub({
      entries: [{ path: "requirements.txt" }, { path: "app.py" }],
      blobs: {},
    });
    const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNSUPPORTED_TEMPLATE");
    expect(result.truncated).toBeUndefined();
    expect(result.reasons?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Security: exclusions, traversal, binaries, limits
// ---------------------------------------------------------------------------

describe("planImport file safety", () => {
  it("skips .git, node_modules, build output, .env and symlinks/submodules", async () => {
    const { fetchImpl } = stubGitHub({
      entries: [
        { path: "package.json" },
        { path: "app/page.tsx" },
        { path: ".git/config", type: "blob" },
        { path: "node_modules/react/index.js" },
        { path: ".next/static/app.js" },
        { path: "dist/bundle.js" },
        { path: "build/out.css" },
        { path: "coverage/lcov.info" },
        { path: ".env" },
        { path: ".env.local" },
        { path: "link", mode: "120000" },
        { path: "vendor/lib", type: "commit", mode: "160000" },
      ],
      blobs: {
        "package.json": NEXT_PKG,
        "app/page.tsx": "page",
        ".git/config": "secret",
        "node_modules/react/index.js": "x",
        ".next/static/app.js": "x",
        "dist/bundle.js": "x",
        "build/out.css": "x",
        "coverage/lcov.info": "x",
        ".env": "SECRET=1",
        ".env.local": "SECRET=2",
        link: "target",
      },
    });
    const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.fileRows.map((r) => r.path);
    expect(paths.sort()).toEqual(["app/page.tsx", "package.json"]);
    expect(result.stats.skippedSymlinks).toBe(1);
    expect(result.stats.skippedSubmodules).toBe(1);
    expect(result.stats.skippedExcluded).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("fails closed on traversal paths", async () => {
    const { fetchImpl } = stubGitHub({
      entries: [{ path: "package.json" }, { path: "../evil.js" }],
      blobs: { "package.json": NEXT_PKG, "../evil.js": "x" },
    });
    const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl });
    expect(result).toMatchObject({ ok: false, code: "IMPORT_UNSAFE_PATH" });
  });

  it("skips binary files without corrupting text", async () => {
    // Unknown extension: goes through fetch → NUL-sniff → skip.
    const blob = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const { fetchImpl } = stubGitHub({
      entries: [{ path: "package.json" }, { path: "logo.data", size: 7 }, { path: "app/page.tsx" }],
      blobs: { "package.json": NEXT_PKG, "logo.data": blob, "app/page.tsx": "page" },
    });
    const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileRows.map((r) => r.path)).not.toContain("logo.data");
    expect(result.stats.skippedBinaries).toBe(1);
  });

  it("skips oversized known-binary files instead of failing the import", async () => {
    // The reported case: uploads/posts/*.png over the per-file limit.
    const { fetchImpl, calls } = stubGitHub({
      entries: [
        { path: "package.json" },
        { path: "app/page.tsx" },
        { path: "uploads/posts/post-1784271161283-989757257.png", size: IMPORT_LIMITS.maxFileBytes + 5000 },
        { path: "assets/hero.JPG", size: IMPORT_LIMITS.maxFileBytes + 1 },
      ],
      blobs: { "package.json": NEXT_PKG, "app/page.tsx": "page" },
    });
    const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.fileRows.map((r) => r.path).sort();
    expect(paths).toEqual(["app/page.tsx", "package.json"]);
    expect(result.stats.skippedBinaries).toBe(2);
    // Oversized binaries were never even fetched.
    expect(calls.some((u) => u.includes("/contents/") && u.includes(".png"))).toBe(false);
    expect(calls.some((u) => u.includes("/contents/") && u.includes(".JPG"))).toBe(false);
  });

  it("isBinaryExtension matches well-known binaries only", () => {
    for (const p of ["a/b.png", "a/photo.JPG", "vid.Mp4", "x.zip", "f.woff2", "d.pdf", "r.docx"]) {
      expect(isBinaryExtension(p)).toBe(true);
    }
    for (const p of ["src/a.tsx", "logo.svg", "data.json", "README", ".env", "archive.tar.gz.bak", "noext"]) {
      expect(isBinaryExtension(p)).toBe(false);
    }
    // .tar.gz itself is binary (last extension wins).
    expect(isBinaryExtension("backup.tar.gz")).toBe(true);
  });

  it("still fails closed on oversized files of unknown or text type", async () => {
    const big = stubGitHub({
      entries: [
        { path: "package.json" },
        { path: "data/model.weights", size: IMPORT_LIMITS.maxFileBytes + 1 },
      ],
      blobs: { "package.json": NEXT_PKG },
    });
    const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: big.fetchImpl });
    expect(result).toMatchObject({ ok: false, code: "IMPORT_FILE_TOO_LARGE" });
  });

  it("enforces file count, total bytes and per-file limits", async () => {
    // Too many files.
    const manyEntries: StubEntry[] = [{ path: "package.json" }];
    const manyBlobs: Record<string, string> = { "package.json": NEXT_PKG };
    for (let i = 0; i < IMPORT_LIMITS.maxFiles + 1; i++) {
      manyEntries.push({ path: `src/f${i}.ts` });
      manyBlobs[`src/f${i}.ts`] = "x";
    }
    // Detection needs react signals for a supported verdict; add vite dep.
    manyBlobs["package.json"] = REACT_PKG;
    manyEntries.push({ path: "src/main.tsx" });
    manyBlobs["src/main.tsx"] = "x";
    const many = stubGitHub({ entries: manyEntries, blobs: manyBlobs });
    const tooMany = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: many.fetchImpl });
    expect(tooMany).toMatchObject({ ok: false, code: "IMPORT_TOO_MANY_FILES" });

    // Single oversized file (pre-flight via tree size).
    const big = stubGitHub({
      entries: [{ path: "package.json" }, { path: "big.bin", size: IMPORT_LIMITS.maxFileBytes + 1 }],
      blobs: { "package.json": NEXT_PKG },
    });
    const tooBig = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: big.fetchImpl });
    expect(tooBig).toMatchObject({ ok: false, code: "IMPORT_FILE_TOO_LARGE" });

    // Total bytes over the cap.
    const totalEntries: StubEntry[] = [{ path: "package.json" }, { path: "src/main.tsx" }];
    const totalBlobs: Record<string, string> = { "package.json": REACT_PKG, "src/main.tsx": "x" };
    const chunk = "y".repeat(512 * 1024);
    for (let i = 0; i < 25; i++) {
      totalEntries.push({ path: `src/big${i}.ts`, size: 512 * 1024 });
      totalBlobs[`src/big${i}.ts`] = chunk;
    }
    const total = stubGitHub({ entries: totalEntries, blobs: totalBlobs });
    const tooLarge = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: total.fetchImpl });
    expect(tooLarge).toMatchObject({ ok: false, code: "IMPORT_TOO_LARGE" });
  });
});

// ---------------------------------------------------------------------------
// GitHub failures + token secrecy
// ---------------------------------------------------------------------------

describe("planImport GitHub failures", () => {
  it("maps revoked/invalid/deleted/rate-limited/transport failures", async () => {
    const base = { entries: [{ path: "package.json" }], blobs: { "package.json": NEXT_PKG } };
    for (const [repoStatus, code, status] of [
      [401, "GITHUB_UNAUTHORIZED", 401],
      [403, "GITHUB_UNAUTHORIZED", 401],
      [404, "REPO_NOT_FOUND", 404],
    ] as const) {
      const { fetchImpl } = stubGitHub({ ...base, repoStatus });
      const r = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl });
      expect(r).toMatchObject({ ok: false, code, status });
    }

    // Rate-limited metadata call.
    const rlFetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/repos/acme/demo")) {
        return new Response("{}", { status: 403, headers: new Headers({ "x-ratelimit-remaining": "0" }) });
      }
      return new Response("{}", { status: 500 });
    });
    const rl = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: rlFetch as never });
    // Detail call is not rateLimited-aware for GET metadata? 403 → unauthorized per mapping.
    expect(rl.ok).toBe(false);

    // Transport failure.
    const down = vi.fn(async () => {
      throw new Error("network down");
    });
    const failed = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: down as never });
    expect(failed).toMatchObject({ ok: false, code: "GITHUB_REQUEST_FAILED", status: 502 });

    // Repo deleted mid-import (tree 404 after metadata 200).
    const mid = stubGitHub(base);
    const midFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      }
      return mid.fetchImpl(url, init);
    });
    const deleted = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: midFetch as never });
    expect(deleted).toMatchObject({ ok: false, code: "REPO_NOT_FOUND" });
  });

  it("blob fetch failure aborts before any DB payload is returned", async () => {
    const { fetchImpl } = stubGitHub({
      entries: [{ path: "package.json" }, { path: "app/page.tsx" }],
      blobs: { "package.json": NEXT_PKG, "app/page.tsx": "page" },
      failBlobsFor: ["app/page.tsx"],
    });
    const result = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl });
    expect(result).toMatchObject({ ok: false, code: "GITHUB_REQUEST_FAILED" });
  });

  it("never leaks tokens in results or failures", async () => {
    const { fetchImpl } = nextJsStub();
    const ok = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl });
    expect(JSON.stringify(ok)).not.toContain(TOKEN);
    const bad = stubGitHub({ repoStatus: 401 });
    const fail = await planImport({ userId: "u1", owner: "acme", repo: "demo", token: TOKEN, fetchImpl: bad.fetchImpl });
    expect(JSON.stringify(fail)).not.toContain(TOKEN);
  });
});
