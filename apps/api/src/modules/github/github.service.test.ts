import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGitHubStatus,
  fetchGitHubUser,
  hasRepoScope,
  parseScopeList,
  resolveConnectionStatus,
  toSafeUser,
} from "./github.service";

/**
 * Phase 1 — GitHub connection unit tests.
 *
 * GitHub API is mocked at the fetch boundary; no network, no DB, no OAuth.
 * Live verification against a dev GitHub account is documented separately
 * (manual validation in the Phase 1 report).
 */

function githubUserResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      id: 123456,
      login: "ravi-dev",
      avatar_url: "https://avatars.example/u/123456",
      name: "Ravi",
      email: "ravi@example.com",
      ...overrides,
    }),
  } as unknown as Response;
}

function mockFetch(response: Response | Error | { status: number }) {
  if (response instanceof Error) {
    return vi.fn(async () => {
      throw response;
    });
  }
  if (response instanceof Response) {
    return vi.fn(async () => response);
  }
  return vi.fn(async () => ({ ok: false, status: response.status }) as Response);
}

function deepKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => deepKeys(v, `${prefix}[${i}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      prefix ? `${prefix}.${k}` : k,
      ...deepKeys(v, prefix ? `${prefix}.${k}` : k),
    ]);
  }
  return [];
}

describe("parseScopeList / hasRepoScope", () => {
  it("detects repo scope in comma- and space-separated grants", () => {
    expect(hasRepoScope("read:user,user:email,repo")).toBe(true);
    expect(hasRepoScope("read:user repo user:email")).toBe(true);
    expect(hasRepoScope("REPO")).toBe(true);
  });

  it("rejects identity-only grants (existing sign-in default)", () => {
    expect(hasRepoScope("read:user,user:email")).toBe(false);
    expect(hasRepoScope(null)).toBe(false);
    expect(hasRepoScope(undefined)).toBe(false);
    expect(hasRepoScope("")).toBe(false);
  });

  it("does not match scope prefixes (e.g. repo_deployment is not repo)", () => {
    expect(hasRepoScope("repo_deployment")).toBe(false);
  });
});

describe("fetchGitHubUser", () => {
  it("returns the user plus authoritative x-oauth-scopes", async () => {
    const res = new Response(JSON.stringify({ id: 42, login: "octo" }), {
      status: 200,
      headers: { "x-oauth-scopes": "read:user, user:email, repo" },
    });
    const out = await fetchGitHubUser("tok", mockFetch(res));
    expect(out).toEqual({
      ok: true,
      user: { id: 42, login: "octo" },
      oauthScopes: "read:user, user:email, repo",
    });
  });

  it("marks 401/403 as revoked (detects revoked authorization)", async () => {
    for (const status of [401, 403]) {
      const out = await fetchGitHubUser("tok", mockFetch({ status }));
      expect(out).toEqual({ ok: false, httpStatus: status, revoked: true });
    }
  });

  it("marks transport failure as non-revoked (transient, not a grant loss)", async () => {
    const out = await fetchGitHubUser("tok", mockFetch(new Error("down")));
    expect(out).toEqual({ ok: false, httpStatus: 0, revoked: false });
  });

  it("rejects malformed identity payloads", async () => {
    const out = await fetchGitHubUser("tok", mockFetch(githubUserResponse({ login: undefined } as never)));
    expect(out.ok).toBe(false);
  });

  it("sends the token only as an Authorization header (never logged)", async () => {
    const fetchImpl = mockFetch(githubUserResponse());
    await fetchGitHubUser("super-secret-token", fetchImpl);
    const [callUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer super-secret-token");
    // The token occurs exactly once in the whole request init (the header).
    expect(JSON.stringify(init).split("super-secret-token")).toHaveLength(2);
  });
});

describe("buildGitHubStatus", () => {
  const conn = {
    status: "connected",
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastValidatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };

  it("reports disconnected when no account is linked", () => {
    const status = buildGitHubStatus({ account: null, connection: null, verification: null });
    expect(status.connected).toBe(false);
    expect(status.githubUser).toBeNull();
    expect(status.authorization).toMatchObject({
      usable: false,
      needsReconnect: false,
      reason: "not_connected",
    });
  });

  it("reports connected+usable for a repo-scoped grant", () => {
    const status = buildGitHubStatus({
      account: { accountId: "42", providerId: "github", accessToken: "t", scope: "repo" },
      connection: conn,
      verification: {
        ok: true,
        user: { id: 42, login: "ravi-dev", avatar_url: "a", name: "R", email: "e" },
        oauthScopes: "read:user,user:email,repo",
      },
    });
    expect(status.connected).toBe(true);
    expect(status.githubUser?.login).toBe("ravi-dev");
    expect(status.authorization.usable).toBe(true);
    expect(status.authorization.capabilities).toEqual({
      repositoryRead: true,
      repositoryWrite: true,
      pullRequest: true,
    });
  });

  it("detects insufficient scope for legacy sign-in grants", () => {
    const status = buildGitHubStatus({
      account: { accountId: "42", providerId: "github", accessToken: "t", scope: "read:user,user:email" },
      connection: conn,
      verification: {
        ok: true,
        user: { id: 42, login: "ravi-dev" },
        oauthScopes: "read:user,user:email",
      },
    });
    expect(status.connected).toBe(true);
    expect(status.authorization).toMatchObject({
      usable: false,
      needsReconnect: true,
      reason: "insufficient_scope",
    });
  });

  it("falls back to stored scope when GitHub omits the header", () => {
    const status = buildGitHubStatus({
      account: { accountId: "42", providerId: "github", accessToken: "t", scope: "repo" },
      connection: conn,
      verification: { ok: true, user: { id: 42, login: "r" }, oauthScopes: null },
    });
    expect(status.authorization.usable).toBe(true);
  });

  it("handles revoked/invalid authorization with reconnect guidance", () => {
    const status = buildGitHubStatus({
      account: { accountId: "42", providerId: "github", accessToken: "t", scope: "repo" },
      connection: conn,
      verification: { ok: false, httpStatus: 401, revoked: true },
    });
    expect(status.authorization).toMatchObject({
      usable: false,
      needsReconnect: true,
      reason: "revoked",
    });
    // Metadata is preserved for the reconnect UX (never silently deleted).
    expect(status.connection?.status).toBe("connected");
  });

  it("flags attention when product state exists but the credential is gone", () => {
    const status = buildGitHubStatus({
      account: { accountId: "42", providerId: "github", accessToken: null, scope: null },
      connection: conn,
      verification: null,
    });
    expect(status.connected).toBe(true);
    expect(status.authorization.needsReconnect).toBe(true);
  });

  it("never exposes tokens, secrets or credentials in any state", () => {
    const states = [
      buildGitHubStatus({ account: null, connection: null, verification: null }),
      buildGitHubStatus({
        account: { accountId: "1", providerId: "github", accessToken: "ACCESS-TOKEN-123", scope: "repo" },
        connection: conn,
        verification: { ok: true, user: { id: 1, login: "u" }, oauthScopes: "repo" },
      }),
      buildGitHubStatus({
        account: { accountId: "1", providerId: "github", accessToken: "ACCESS-TOKEN-123", scope: "repo" },
        connection: conn,
        verification: { ok: false, httpStatus: 401, revoked: true },
      }),
    ];
    for (const state of states) {
      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain("ACCESS-TOKEN-123");
      const keys = deepKeys(state).join(" ").toLowerCase();
      expect(keys).not.toMatch(/token|secret|credential|password/);
    }
  });
});

describe("toSafeUser / resolveConnectionStatus", () => {
  it("derives identity from the GitHub API payload (server-side, not client input)", () => {
    expect(toSafeUser({ id: 99, login: "ananya", avatar_url: null })).toEqual({
      id: "99",
      login: "ananya",
      avatarUrl: null,
      name: null,
      email: null,
    });
  });

  it("maps usable authorization to connected, else needs_reconnect", () => {
    const usable = buildGitHubStatus({
      account: { accountId: "1", providerId: "github", accessToken: "t", scope: "repo" },
      connection: null,
      verification: { ok: true, user: { id: 1, login: "u" }, oauthScopes: "repo" },
    });
    expect(resolveConnectionStatus(usable.authorization)).toBe("connected");
    const bad = buildGitHubStatus({ account: null, connection: null, verification: null });
    expect(resolveConnectionStatus(bad.authorization)).toBe("needs_reconnect");
  });
});

describe("controller identity ownership (static guarantee)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("controller source never reads identity from client input", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = path.join(__dirname, "github.controller.ts");
    const src = fs.readFileSync(file, "utf8");
    // userId must only come from the session.
    expect(src).toContain("req.user!");
    expect(src).not.toMatch(/req\.body\.(userId|githubUserId|githubLogin)/);
    expect(src).not.toMatch(/req\.query\.(userId|githubUserId|githubLogin)/);
    expect(src).not.toMatch(/req\.params\.(userId|githubUserId|githubLogin)/);
    // Credential identifiers may only appear in allow-listed safe contexts:
    // reading the stored grant, authorizing the GitHub call, or clearing
    // grants on disconnect — never serialized into a response.
    const stripped = src
      .replace(/account\?\.accessToken/g, "")
      .replace(/account\.accessToken/g, "")
      .replace(/fetchGitHubUser\(token\)/g, "")
      .replace(/accessToken: true/g, "")
      .replace(/(accessToken|refreshToken|idToken|accessTokenExpiresAt|refreshTokenExpiresAt): null/g, "");
    expect(stripped).not.toMatch(/accessToken|refreshToken|clientSecret/);
    expect(src).not.toMatch(/res\.json\([^)]*(token|secret)/i);
  });
});
