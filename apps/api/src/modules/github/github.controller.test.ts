import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 1 — controller tests with mocked persistence + mocked GitHub API.
 * Proves server-owned identity linkage, safe disconnect semantics, and
 * correct status codes without touching a real database or GitHub.
 */

const fns = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  accountUpdateMany: vi.fn(),
  connFindUnique: vi.fn(),
  connUpsert: vi.fn(),
  connUpdate: vi.fn(),
  connDeleteMany: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  prisma: {
    account: {
      findFirst: fns.accountFindFirst,
      updateMany: fns.accountUpdateMany,
    },
    gitHubConnection: {
      findUnique: fns.connFindUnique,
      upsert: fns.connUpsert,
      update: fns.connUpdate,
      deleteMany: fns.connDeleteMany,
    },
  },
}));

import { githubController } from "./github.controller";

function reqRes(userId: string, body: Record<string, unknown> = {}) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const req = { user: { id: userId }, body } as never;
  const res = { status, json } as never;
  return { req, res, status, json };
}

function stubGitHubApi(user: Record<string, unknown>, scopes: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === "x-oauth-scopes" ? scopes : null) },
      json: async () => user,
    })),
  );
}

const ghUser = { id: 777, login: "ravi-dev", avatar_url: "a", name: "R", email: "r@x" };

beforeEach(() => {
  vi.unstubAllGlobals();
  Object.values(fns).forEach((fn) => fn.mockReset());
});

describe("githubController.getStatus", () => {
  it("reports disconnected for users with no GitHub account (IDE still works)", async () => {
    fns.accountFindFirst.mockResolvedValue(null);
    fns.connFindUnique.mockResolvedValue(null);
    const { req, res, status, json } = reqRes("u-email-user");
    await githubController.getStatus(req, res);
    expect(status).toHaveBeenCalledWith(200);
    const body = json.mock.calls[0][0] as { data: { connected: boolean } };
    expect(body.data.connected).toBe(false);
    expect(JSON.stringify(body)).not.toContain("token");
  });

  it("links state to the session user, ignoring spoofed client identity", async () => {
    stubGitHubApi(ghUser, "read:user,user:email,repo");
    fns.accountFindFirst.mockResolvedValue({
      accountId: "777",
      providerId: "github",
      accessToken: "real-token",
      scope: "repo",
    });
    fns.connFindUnique.mockResolvedValue(null);
    fns.connUpsert.mockResolvedValue({
      status: "connected",
      connectedAt: new Date(),
      lastValidatedAt: new Date(),
    });
    // Attacker claims to be another IDE user / GitHub login in the body.
    const { req, res, json } = reqRes("u-victim", {
      userId: "u-someone-else",
      githubUserId: "1",
      login: "attacker",
    });
    await githubController.getStatus(req, res);
    expect(fns.accountFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-victim", providerId: "github" } }),
    );
    expect(fns.connUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u-victim" } }),
    );
    const body = json.mock.calls[0][0] as { data: { githubUser: { login: string } } };
    // Identity comes from GitHub API, not client input.
    expect(body.data.githubUser.login).toBe("ravi-dev");
  });

  it("does not create a duplicate IDE user or touch project data", async () => {
    stubGitHubApi(ghUser, "repo");
    fns.accountFindFirst.mockResolvedValue({
      accountId: "777",
      providerId: "github",
      accessToken: "t",
      scope: "repo",
    });
    fns.connFindUnique.mockResolvedValue(null);
    fns.connUpsert.mockResolvedValue({
      status: "connected",
      connectedAt: new Date(),
      lastValidatedAt: new Date(),
    });
    const { req, res } = reqRes("u-google-user");
    await githubController.getStatus(req, res);
    // Only delegates available on the mocked prisma are account/gitHubConnection;
    // any access to user/project/file delegates would throw — it did not.
    expect(fns.connUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("githubController.connect", () => {
  it("returns GITHUB_NOT_LINKED when no OAuth grant exists yet", async () => {
    fns.accountFindFirst.mockResolvedValue(null);
    const { req, res, status, json } = reqRes("u1");
    await githubController.connect(req, res);
    expect(status).toHaveBeenCalledWith(409);
    expect((json.mock.calls[0][0] as { code: string }).code).toBe("GITHUB_NOT_LINKED");
  });

  it("returns INSUFFICIENT_SCOPE without persisting a connection", async () => {
    stubGitHubApi(ghUser, "read:user,user:email");
    fns.accountFindFirst.mockResolvedValue({
      accountId: "777",
      providerId: "github",
      accessToken: "t",
      scope: "read:user,user:email",
    });
    const { req, res, status, json } = reqRes("u1");
    await githubController.connect(req, res);
    expect(status).toHaveBeenCalledWith(422);
    expect((json.mock.calls[0][0] as { code: string }).code).toBe("INSUFFICIENT_SCOPE");
    expect(fns.connUpsert).not.toHaveBeenCalled();
  });
});

describe("githubController.disconnect", () => {
  it("clears only GitHub state; never deletes IDE account or project data", async () => {
    fns.connDeleteMany.mockResolvedValue({ count: 1 });
    fns.accountUpdateMany.mockResolvedValue({ count: 1 });
    const { req, res, status, json } = reqRes("u1");
    await githubController.disconnect(req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(fns.connDeleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    // Credential fields cleared; the Account row (sign-in linkage) is kept.
    expect(fns.accountUpdateMany).toHaveBeenCalledWith({
      where: { userId: "u1", providerId: "github" },
      data: expect.objectContaining({ accessToken: null, scope: null }),
    });
    expect((json.mock.calls[0][0] as { data: { disconnected: boolean } }).data).toEqual({
      disconnected: true,
    });
  });
});

describe("github routes", () => {
  it("protects every endpoint with authenticate (unauthenticated users rejected)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "github.routes.ts"), "utf8");
    expect(src).toContain("router.use(authenticate)");
    expect(src).toContain('"/status"');
    expect(src).toContain('"/connect"');
    expect(src).toContain('"/disconnect"');
  });
});
