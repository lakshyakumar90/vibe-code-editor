import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2 — repository discovery tests. GitHub is mocked at the fetch
 * boundary; persistence is mocked. No network, no DB.
 */

const fns = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  prisma: {
    account: { findFirst: fns.accountFindFirst },
    gitHubConnection: {},
  },
}));

import { reposController } from "./repos.controller";

const TOKEN = "gh-test-token";

function reqRes(userId: string, query: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const req = { user: { id: userId }, query, params, body: {} } as never;
  const res = { status, json } as never;
  return { req, res, status, json };
}

function ghResponse(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers ?? {});
  return new Response(init.status && init.status !== 200 ? JSON.stringify(data) : JSON.stringify(data), {
    status: init.status ?? 200,
    headers,
  });
}

function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => handler(url)));
}

const repoRaw = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: "my-next-app",
  full_name: "ravi-dev/my-next-app",
  owner: { login: "ravi-dev", type: "User" },
  private: false,
  fork: false,
  default_branch: "main",
  html_url: "https://github.com/ravi-dev/my-next-app",
  description: "demo",
  language: "TypeScript",
  stargazers_count: 3,
  updated_at: "2026-01-01T00:00:00Z",
  permissions: { pull: true, push: true, admin: false, maintain: false, triage: false },
  ...overrides,
});

beforeEach(() => {
  vi.unstubAllGlobals();
  fns.accountFindFirst.mockReset();
  fns.accountFindFirst.mockResolvedValue({ accessToken: TOKEN, scope: "repo" });
});

function deepKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => deepKeys(v, `${prefix}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      prefix ? `${prefix}.${k}` : k,
      ...deepKeys(v, prefix ? `${prefix}.${k}` : k),
    ]);
  }
  return [];
}

describe("reposController.listRepos", () => {
  it("18. disconnected GitHub → 409 connection error (not 500)", async () => {
    fns.accountFindFirst.mockResolvedValue(null);
    const { req, res, status, json } = reqRes("u1", {});
    await reposController.listRepos(req, res);
    expect(status).toHaveBeenCalledWith(409);
    expect((json.mock.calls[0][0] as { code: string }).code).toBe("GITHUB_NOT_CONNECTED");
  });

  it("19/22/23. returns normalized DTO with visibility + normalized permissions", async () => {
    stubFetch(() =>
      ghResponse([repoRaw(), repoRaw({ id: 2, name: "secret", full_name: "o/secret", private: true, permissions: { pull: true, push: false, admin: false } })], {
        headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"', "x-oauth-scopes": "repo" },
      }),
    );
    const { req, res, status, json } = reqRes("u1", { page: "1", perPage: "30" });
    await reposController.listRepos(req, res);
    expect(status).toHaveBeenCalledWith(200);
    const body = json.mock.calls[0][0] as {
      data: { repos: Record<string, unknown>[]; meta: Record<string, unknown> };
    };
    expect(body.data.repos).toHaveLength(2);
    const [pub, priv] = body.data.repos as Array<{
      private: boolean;
      access: { canRead: boolean; canWrite: boolean; canAdmin: boolean };
      permissions: { push: boolean };
    }>;
    expect(pub!.private).toBe(false);
    expect(pub!.access).toEqual({ canRead: true, canWrite: true, canAdmin: false });
    expect(priv!.private).toBe(true);
    expect(priv!.access.canWrite).toBe(false);
    expect(body.data.meta).toMatchObject({ page: 1, perPage: 30, hasNextPage: true, grantedRepoAccess: true });
  });

  it("20. tokens never appear in list responses", async () => {
    stubFetch(() => ghResponse([repoRaw()]));
    const { req, res, json } = reqRes("u1", {});
    await reposController.listRepos(req, res);
    const serialized = JSON.stringify(json.mock.calls[0][0]);
    expect(serialized).not.toContain(TOKEN);
    expect(deepKeys(json.mock.calls[0][0]).join(" ").toLowerCase()).not.toMatch(/token|secret|credential|authorization/);
  });

  it("25. cross-user: account lookup always uses the session user", async () => {
    stubFetch(() => ghResponse([]));
    const { req, res } = reqRes("u-victim", { q: "x" });
    (req as unknown as { body: unknown }).body = { userId: "u-attacker" };
    await reposController.listRepos(req, res);
    expect(fns.accountFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-victim", providerId: "github" } }),
    );
  });

  it("26. GitHub 401 → GITHUB_UNAUTHORIZED; transport failure → safe 502", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    const { req, res, status, json } = reqRes("u1", {});
    await reposController.listRepos(req, res);
    expect(status).toHaveBeenCalledWith(401);
    expect((json.mock.calls[0][0] as { code: string }).code).toBe("GITHUB_UNAUTHORIZED");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const second = reqRes("u1", {});
    await reposController.listRepos(second.req, second.res);
    expect(second.status).toHaveBeenCalledWith(502);
    expect(JSON.stringify(second.json.mock.calls[0][0])).not.toContain("down");
  });

  it("search filters application-side within a bounded fetch", async () => {
    stubFetch(() => ghResponse([repoRaw(), repoRaw({ id: 5, name: "other", full_name: "o/other" })]));
    const { req, res, json } = reqRes("u1", { q: "next-app" });
    await reposController.listRepos(req, res);
    const body = json.mock.calls[0][0] as { data: { repos: { name: string }[]; meta: { filtered: boolean } } };
    expect(body.data.repos.map((r) => r.name)).toEqual(["my-next-app"]);
    expect(body.data.meta.filtered).toBe(true);
  });
});

describe("reposController.getRepo / getInspection", () => {
  it("21/24. invalid slugs rejected; GitHub 404 stays 404 without existence oracle", async () => {
    for (const params of [{ owner: "..", repo: "x" }, { owner: "a/b", repo: "x" }, { owner: "o", repo: "" }]) {
      const { req, res, status } = reqRes("u1", {}, params as Record<string, string>);
      await reposController.getRepo(req, res);
      expect(status).toHaveBeenCalledWith(400);
    }
    stubFetch(() => new Response("{}", { status: 404 }));
    const { req, res, status, json } = reqRes("u1", {}, { owner: "o", repo: "nope" });
    await reposController.getRepo(req, res);
    expect(status).toHaveBeenCalledWith(404);
    expect((json.mock.calls[0][0] as { code: string }).code).toBe("REPO_NOT_FOUND");
  });

  it("24. metadata verifies authorization: GitHub 401 → 401 reconnect guidance", async () => {
    stubFetch(() => new Response("{}", { status: 401 }));
    const { req, res, status, json } = reqRes("u1", {}, { owner: "o", repo: "r" });
    await reposController.getRepo(req, res);
    expect(status).toHaveBeenCalledWith(401);
    expect((json.mock.calls[0][0] as { code: string }).code).toBe("GITHUB_UNAUTHORIZED");
  });

  it("metadata returns parent + latest SHA without raw payload", async () => {
    stubFetch((url) => {
      if (url.includes("/commits/")) return ghResponse([{ sha: "abc123" }]);
      return ghResponse({ ...repoRaw(), fork: true, parent: { full_name: "up/stream", html_url: "https://github.com/up/stream" } });
    });
    const { req, res, status, json } = reqRes("u1", {}, { owner: "o", repo: "r" });
    await reposController.getRepo(req, res);
    expect(status).toHaveBeenCalledWith(200);
    const data = (json.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ latestSha: "abc123", parent: { fullName: "up/stream" } });
    expect(JSON.stringify(data)).not.toContain(TOKEN);
  });

  it("27. truncated tree never produces SUPPORTED", async () => {
    const pkgB64 = Buffer.from(JSON.stringify({ dependencies: { next: "1.0.0" } })).toString("base64");
    stubFetch((url) => {
      if (url.includes("/commits/")) return ghResponse([{ sha: "s" }]);
      if (url.includes("/git/trees/")) return ghResponse({ truncated: true, tree: [] });
      if (url.includes("/contents/")) return ghResponse({ content: pkgB64, encoding: "base64", size: 10 });
      return ghResponse(repoRaw());
    });
    const { req, res, status, json } = reqRes("u1", {}, { owner: "o", repo: "r" });
    await reposController.getInspection(req, res);
    expect(status).toHaveBeenCalledWith(200);
    const data = (json.mock.calls[0][0] as { data: { truncated: boolean; detection: { kind: string } } }).data;
    expect(data.truncated).toBe(true);
    expect(data.detection.kind).toBe("unsupported");
  });

  it("inspection detects a supported root end-to-end (mocked)", async () => {
    const pkgB64 = Buffer.from(
      JSON.stringify({ dependencies: { react: "^18.0.0", vite: "^5.0.0" } }),
    ).toString("base64");
    stubFetch((url) => {
      if (url.includes("/commits/")) return ghResponse([{ sha: "s" }]);
      if (url.includes("/git/trees/")) {
        return ghResponse({
          truncated: false,
          tree: [
            { path: "package.json", type: "blob" },
            { path: "src/main.tsx", type: "blob" },
            { path: "src", type: "tree" },
          ],
        });
      }
      if (url.includes("/contents/")) return ghResponse({ content: pkgB64, encoding: "base64", size: 10 });
      return ghResponse(repoRaw());
    });
    const { req, res, status, json } = reqRes("u1", {}, { owner: "o", repo: "r" });
    await reposController.getInspection(req, res);
    expect(status).toHaveBeenCalledWith(200);
    const data = (json.mock.calls[0][0] as { data: { detection: { kind: string; template?: string } } }).data;
    expect(data.detection).toMatchObject({ kind: "supported", template: "REACT" });
  });
});

describe("no arbitrary proxy (static guarantees)", () => {
  it("17. all repo routes sit behind authenticate; service builds only fixed URLs", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = __dirname;
    const routes = fs.readFileSync(path.join(dir, "github.routes.ts"), "utf8");
    expect(routes).toContain("router.use(authenticate)");
    const svc = fs.readFileSync(path.join(dir, "repos.service.ts"), "utf8");
    // Every network call goes through fetchImpl with the fixed API base.
    // (https://github.com display-link fallbacks in normalizeRepo are not
    // fetch targets and are built from API-returned slugs only.)
    expect(svc).not.toMatch(/(?<!fetchImpl\()\bfetch\(/);
    const calls = [...svc.matchAll(/fetchImpl\(\s*`([^`]+)`/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.startsWith("${API}")).toBe(true);
    expect(svc).not.toMatch(/req\.query\.(url|apiUrl|endpoint)/);
    expect(svc).not.toMatch(/req\.body\.(url|apiUrl|endpoint|token)/);
  });
});
