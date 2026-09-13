import { describe, expect, it, vi } from "vitest";

/**
 * Phase 4B.5 — GitHub repository creation + org listing.
 * HTTP is injected per call (no module mocks): only the fixed
 * api.github.com paths may ever be requested.
 */

import {
  createOrgRepo,
  createUserRepo,
  isValidRepoName,
  listUserOrgs,
  normalizePublishDescription,
  type GitHubFetch,
} from "./repos.service";

function fakeResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => data,
  } as unknown as Response;
}

function rawRepo(fullName: string) {
  const [owner, name] = fullName.split("/");
  return {
    id: 99,
    name,
    full_name: fullName,
    owner: { login: owner, type: "User" },
    private: true,
    fork: false,
    default_branch: "main",
    html_url: `https://github.com/${fullName}`,
    description: null,
    language: null,
    stargazers_count: 0,
    updated_at: null,
    permissions: { pull: true, push: true, admin: false, maintain: false, triage: false },
  };
}

describe("isValidRepoName / normalizePublishDescription (pure)", () => {
  it("accepts GitHub-compatible names", () => {
    for (const good of ["my-project", "a", "x".repeat(100), "a.b_c-d", "UPPER"]) {
      expect(isValidRepoName(good), good).toBe(true);
    }
  });

  it("rejects hostile names", () => {
    for (const bad of ["", ".", "..", "a/b", "a b", "a@b", "../x", "x".repeat(101), 42, null]) {
      expect(isValidRepoName(bad), String(bad)).toBe(false);
    }
  });

  it("normalizes descriptions", () => {
    expect(normalizePublishDescription("  hi  ")).toBe("hi");
    expect(normalizePublishDescription("")).toBeUndefined();
    expect(normalizePublishDescription("   ")).toBeUndefined();
    expect(normalizePublishDescription(42)).toBeUndefined();
    expect(normalizePublishDescription("x".repeat(2000))).toHaveLength(1000);
  });
});

describe("createUserRepo", () => {
  it("POSTs a fixed path with explicit fields and normalizes the DTO", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: GitHubFetch = async (url, init) => {
      calls.push({ url, init });
      return fakeResponse(rawRepo("acme/newthing"), 201);
    };
    const result = await createUserRepo(
      "tok",
      { name: "newthing", description: "hi", private: true },
      fetchImpl,
    );
    expect(result.error).toBeNull();
    expect(result.repo).toMatchObject({
      fullName: "acme/newthing",
      private: true,
      access: { canWrite: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/user/repos");
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ name: "newthing", description: "hi", private: true, auto_init: false });
    // Token travels in the Authorization header only — never in URL or body.
    expect(calls[0]!.url).not.toContain("tok");
    expect(JSON.stringify(body)).not.toContain("tok");
  });

  it("maps collisions and denials to statuses (no DTO)", async () => {
    const taken: GitHubFetch = async () => fakeResponse({ message: "taken" }, 422);
    await expect(createUserRepo("tok", { name: "taken", private: true }, taken)).resolves.toMatchObject({
      repo: null,
      error: { status: 422 },
    });
    const denied: GitHubFetch = async () => fakeResponse({ message: "no" }, 403);
    await expect(createUserRepo("tok", { name: "x", private: true }, denied)).resolves.toMatchObject({
      error: { status: 403 },
    });
    const down: GitHubFetch = async () => {
      throw new Error("boom");
    };
    await expect(createUserRepo("tok", { name: "x", private: true }, down)).resolves.toMatchObject({
      error: { status: 0 },
    });
  });
});

describe("createOrgRepo", () => {
  it("POSTs the fixed org path for valid orgs", async () => {
    const calls: string[] = [];
    const fetchImpl: GitHubFetch = async (url) => {
      calls.push(url);
      return fakeResponse(rawRepo("myorg/app"), 201);
    };
    const result = await createOrgRepo("tok", "myorg", { name: "app", private: false }, fetchImpl);
    expect(result.repo?.fullName).toBe("myorg/app");
    expect(calls).toEqual(["https://api.github.com/orgs/myorg/repos"]);
  });

  it("never calls the network for an invalid org", async () => {
    const fetchImpl: GitHubFetch = vi.fn(async () => fakeResponse({}, 200));
    const result = await createOrgRepo("tok", "a/b", { name: "app", private: true }, fetchImpl);
    expect(result).toMatchObject({ repo: null, error: { status: 400 } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("listUserOrgs", () => {
  it("returns validated, deduplicated logins", async () => {
    const fetchImpl: GitHubFetch = async () =>
      fakeResponse([{ login: "myorg" }, { login: "myorg" }, { login: "a/b" }, { login: 42 }, null], 200);
    const result = await listUserOrgs("tok", fetchImpl);
    expect(result).toEqual({ orgs: ["myorg"], error: null });
  });

  it("surfaces auth failures", async () => {
    const fetchImpl: GitHubFetch = async () => fakeResponse({ message: "bad" }, 401);
    await expect(listUserOrgs("tok", fetchImpl)).resolves.toMatchObject({
      orgs: [],
      error: { status: 401 },
    });
  });
});
