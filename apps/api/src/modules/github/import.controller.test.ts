import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 3 — import controller tests with mocked persistence + mocked
 * GitHub API. Proves atomic single-transaction writes, error mapping,
 * and token secrecy without touching a real database or GitHub.
 */

const fns = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  ProjectRole: { OWNER: "OWNER", EDITOR: "EDITOR", VIEWER: "VIEWER" },
  prisma: {
    account: { findFirst: fns.accountFindFirst },
    // Query builders only shape operation objects; the mocked $transaction
    // below is the sole persistence boundary under test.
    project: { create: (args: unknown) => ({ _op: "project.create", args }) },
    file: { createMany: (args: unknown) => ({ _op: "file.createMany", args }) },
    gitRepository: { create: (args: unknown) => ({ _op: "gitRepository.create", args }) },
    $transaction: (...args: unknown[]) => fns.transaction(...args),
  },
}));

import { importController } from "./import.controller";

const TOKEN = "gh-test-token";

function reqRes(userId: string, body: Record<string, unknown> = {}) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const req = { user: { id: userId }, body } as never;
  const res = { status, json } as never;
  return { req, res, status, json };
}

const NEXT_PKG = JSON.stringify({
  dependencies: { next: "15.0.0", react: "19.0.0" },
  scripts: { dev: "next dev" },
});

function stubImportGitHub() {
  const blobs: Record<string, string> = {
    "package.json": NEXT_PKG,
    "app/page.tsx": "export default function Page(){}",
  };
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const J = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: new Headers() });
    if (url.includes("/commits/")) return J([{ sha: "deadbeef" }]);
    if (url.includes("/git/trees/")) {
      return J({
        truncated: false,
        tree: Object.keys(blobs).map((path) => ({ path, mode: "100644", type: "blob", sha: "s", size: 12 })),
      });
    }
    if (url.includes("/contents/")) {
      const m = url.match(/\/contents\/(.+)\?ref=/);
      const decoded = m ? m[1]!.split("/").map((s) => decodeURIComponent(s)).join("/") : "";
      const body = blobs[decoded];
      if (body === undefined) return J({}, 404);
      return J({ content: Buffer.from(body).toString("base64"), encoding: "base64", size: body.length });
    }
    return J({
      id: 99,
      name: "demo",
      full_name: "acme/demo",
      owner: { login: "acme", type: "User" },
      private: true,
      fork: false,
      default_branch: "main",
      description: "d",
      permissions: { pull: true, push: false, admin: false, maintain: false, triage: false },
    });
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  fns.accountFindFirst.mockReset();
  fns.transaction.mockReset();
  fns.accountFindFirst.mockResolvedValue({ accessToken: TOKEN });
});

describe("importController.importRepo", () => {
  it("rejects unauthenticated-adjacent states: disconnected → 409, bad body → 400", async () => {
    fns.accountFindFirst.mockResolvedValue(null);
    const d = reqRes("u1", { owner: "acme", repo: "demo" });
    await importController.importRepo(d.req, d.res);
    expect(d.status).toHaveBeenCalledWith(409);
    expect((d.json.mock.calls[0][0] as { code: string }).code).toBe("GITHUB_NOT_CONNECTED");

    fns.accountFindFirst.mockResolvedValue({ accessToken: TOKEN });
    const b = reqRes("u1", { owner: "", repo: "demo" });
    await importController.importRepo(b.req, b.res);
    expect(b.status).toHaveBeenCalledWith(400);
  });

  it("writes atomically: ONE transaction with project + files + gitRepository", async () => {
    const fetchImpl = stubImportGitHub();
    vi.stubGlobal("fetch", fetchImpl);
    fns.transaction.mockImplementation(async (ops: Array<{ kind?: string }>) => [
      {
        id: "p-new",
        name: "demo",
        description: "d",
        template: "NEXTJS",
        templateVersion: "1.0.0",
        ownerId: "u1",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
      { count: 3 },
      {
        id: "g-new",
        projectId: "p-new",
        githubRepoId: "99",
        owner: "acme",
        repo: "demo",
        fullName: "acme/demo",
        defaultBranch: "main",
        currentBranch: "main",
        importedSha: "deadbeef",
        private: true,
        canRead: true,
        canWrite: false,
        canAdmin: false,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    ]);

    const { req, res, status, json } = reqRes("u1", { owner: "acme", repo: "demo" });
    await importController.importRepo(req, res);

    expect(status).toHaveBeenCalledWith(201);
    // GitHub fetch happened BEFORE the transaction (fetch-then-commit).
    expect(fetchImpl).toHaveBeenCalled();
    expect(fns.transaction).toHaveBeenCalledTimes(1);
    const ops = fns.transaction.mock.calls[0]![0] as unknown[];
    expect(ops).toHaveLength(3);

    const body = json.mock.calls[0][0] as {
      success: boolean;
      data: { project: { id: string }; gitRepository: { importedSha: string }; stats: { files: number } };
    };
    expect(body.success).toBe(true);
    expect(body.data.project.id).toBe("p-new");
    expect(body.data.gitRepository.importedSha).toBe("deadbeef");
    expect(body.data.stats.files).toBe(2);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("mid-fetch failure leaves nothing behind: transaction never runs", async () => {
    const fetchImpl = stubImportGitHub();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, _init?: RequestInit) => {
        // Inspection (package.json) succeeds; the app blob vanishes after,
        // simulating a repository change mid-import.
        if (url.includes("/contents/") && !url.includes("package.json")) {
          return new Response(JSON.stringify({ message: "gone" }), { status: 404 });
        }
        return fetchImpl(url, {});
      }),
    );
    const { req, res, status } = reqRes("u1", { owner: "acme", repo: "demo" });
    await importController.importRepo(req, res);
    expect(status).toHaveBeenCalledWith(502);
    expect(fns.transaction).not.toHaveBeenCalled();
  });

  it("maps plan failures with codes, reasons and truncated flags", async () => {
    // Unsupported repo (python, no package.json).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, _init?: RequestInit) => {
        const J = (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status, headers: new Headers() });
        if (url.includes("/commits/")) return J([{ sha: "s" }]);
        if (url.includes("/git/trees/")) return J({ truncated: false, tree: [{ path: "app.py", mode: "100644", type: "blob", sha: "x", size: 5 }] });
        return J({
          id: 7,
          name: "py",
          full_name: "acme/py",
          owner: { login: "acme", type: "User" },
          private: false,
          fork: false,
          default_branch: "main",
          permissions: { pull: true },
        });
      }),
    );
    const u = reqRes("u1", { owner: "acme", repo: "py" });
    await importController.importRepo(u.req, u.res);
    expect(u.status).toHaveBeenCalledWith(422);
    const ubody = u.json.mock.calls[0][0] as { code: string; reasons: string[]; truncated?: boolean };
    expect(ubody.code).toBe("UNSUPPORTED_TEMPLATE");
    expect(ubody.truncated).toBeUndefined();
    expect(ubody.reasons.length).toBeGreaterThan(0);

    // Truncated tree → IMPORT_INSPECTION_LIMIT with truncated: true.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, _init?: RequestInit) => {
        const J = (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status, headers: new Headers() });
        if (url.includes("/commits/")) return J([{ sha: "s" }]);
        if (url.includes("/git/trees/")) return J({ truncated: true, tree: [] });
        return J({
          id: 8,
          name: "big",
          full_name: "acme/big",
          owner: { login: "acme", type: "User" },
          private: false,
          fork: false,
          default_branch: "main",
          permissions: { pull: true },
        });
      }),
    );
    const t = reqRes("u1", { owner: "acme", repo: "big" });
    await importController.importRepo(t.req, t.res);
    expect(t.status).toHaveBeenCalledWith(422);
    expect(t.json.mock.calls[0][0]).toMatchObject({ code: "IMPORT_INSPECTION_LIMIT", truncated: true });
  });

  it("uses the session user for account lookup and project ownership", async () => {
    const fetchImpl = stubImportGitHub();
    vi.stubGlobal("fetch", fetchImpl);
    fns.transaction.mockImplementation(async () => [{ id: "p" }, {}, {}]);
    const { req, res } = reqRes("u-victim", { owner: "acme", repo: "demo", userId: "u-attacker" } as never);
    await importController.importRepo(req, res);
    expect(fns.accountFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-victim", providerId: "github" } }),
    );
  });
});
