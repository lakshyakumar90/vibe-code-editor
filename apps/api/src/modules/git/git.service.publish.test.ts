import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGitLocks } from "./git.lock";

/**
 * Phase 4B.5 — Add Remote / Publish orchestration tests.
 * Engine, transport, persistence and the GitHub API are mocked; real-git
 * behavior of the new transport primitives is covered in git.remote.test.ts
 * and creation mapping in repos.create.test.ts.
 */

const engineMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  revparseHead: vi.fn(),
  currentBranch: vi.fn(),
  initRepo: vi.fn(),
  stageAll: vi.fn(),
  stagePaths: vi.fn(),
  unstageAll: vi.fn(),
  unstagePaths: vi.fn(),
  discardPaths: vi.fn(),
  commitStaged: vi.fn(),
  commitAllowEmpty: vi.fn(),
  ensureIdentity: vi.fn(),
  diffFile: vi.fn(),
}));

vi.mock("./git.engine", () => engineMocks);

const LOCAL_SHA = "b".repeat(40);
const REMOTE_SHA = "c".repeat(40);

let currentOriginUrl = "https://github.com/acme/demo.git";

const remoteMocks = vi.hoisted(() => ({
  getCloneMarker: vi.fn(async (): Promise<string | null> => "clone"),
  commitCount: vi.fn(async (): Promise<number | null> => 2),
  fetchOrigin: vi.fn(async () => undefined),
  getRemoteUrl: vi.fn(async (): Promise<string | null> => currentOriginUrl),
  setRemoteUrl: vi.fn(async () => undefined),
  removeRemote: vi.fn(async () => undefined),
  lsRemoteHead: vi.fn(async (): Promise<string | null> => null),
  isAncestor: vi.fn(async (): Promise<boolean> => false),
  listBranches: vi.fn(async () => [
    { name: "main", current: true, remote: false, commit: LOCAL_SHA },
  ]),
  getUpstream: vi.fn(async (): Promise<string | null> => null),
  aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })),
  mergeFastForward: vi.fn(async () => ({ updated: false, newSha: null })),
  pushBranch: vi.fn(async () => undefined),
  createBranch: vi.fn(async () => undefined),
  checkoutBranch: vi.fn(async () => undefined),
  checkoutTracking: vi.fn(async () => undefined),
  validateBranchRef: vi.fn(async () => undefined),
  cloneRepo: vi.fn(async () => undefined),
  setCloneMarker: vi.fn(async () => undefined),
  setSparseRoot: vi.fn(async () => undefined),
  tryRevparse: vi.fn(async (): Promise<string | null> => null),
  logCommits: vi.fn(async () => []),
  commitMeta: vi.fn(async () => ({
    sha: "",
    shortSha: "",
    message: "",
    authorName: "",
    authorEmail: "",
    timestamp: new Date(0).toISOString(),
    parents: [],
  })),
  commitFileChanges: vi.fn(async () => ({ parents: [], files: [] })),
  historyFileDiff: vi.fn(async () => ({
    path: "",
    status: "modified",
    sha: "",
    isBinary: false,
    tooLarge: false,
    oldContent: null,
    newContent: null,
  })),
  gitAuthEnv: vi.fn(() => ({})),
}));

vi.mock("./git.remote", () => ({ ...remoteMocks, CLONE_MARKER_VALUE: "clone" }));

// Stateful binding: update/create merge into the live row so multi-step
// flows (attach → remote-state, publish → push) observe persistence.
let dbLink: Record<string, unknown> = {};

const dbMocks = vi.hoisted(() => ({
  gitRepositoryFindUnique: vi.fn(),
  gitRepositoryUpdate: vi.fn(),
  gitRepositoryCreate: vi.fn(),
  accountFindFirst: vi.fn(),
  fileFindMany: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  prisma: {
    gitRepository: {
      findUnique: dbMocks.gitRepositoryFindUnique,
      update: dbMocks.gitRepositoryUpdate,
      create: dbMocks.gitRepositoryCreate,
    },
    account: {
      findFirst: dbMocks.accountFindFirst,
      findMany: async (...args: unknown[]) => {
        const row = await dbMocks.accountFindFirst(...args);
        return row ? [row] : [];
      },
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    file: { findMany: dbMocks.fileFindMany },
  },
}));

const fileRepoMocks = vi.hoisted(() => ({
  getFileByPath: vi.fn(),
  updateFile: vi.fn(),
  deleteFile: vi.fn(),
  createFile: vi.fn(),
}));

vi.mock("../projects/files/file.repository", () => ({
  fileRepository: {
    getFileByPath: fileRepoMocks.getFileByPath,
    updateFile: fileRepoMocks.updateFile,
    deleteFile: fileRepoMocks.deleteFile,
    createFile: fileRepoMocks.createFile,
  },
}));

const eventMocks = vi.hoisted(() => ({
  tree: vi.fn(),
  content: vi.fn(),
}));

vi.mock("../projects/files/file.events", () => ({
  emitFileTreeChanged: eventMocks.tree,
  emitFileContentChanged: eventMocks.content,
}));

vi.mock("../collab/collab.editor", () => ({
  getActiveEditorService: vi.fn(() => null),
}));

// Live token validation (getGitHubToken → fetchGitHubUser): default to a
// revoked grant so stored-scope checks stay deterministic; individual tests
// override per case.
const githubAuthMocks = vi.hoisted(() => ({
  fetchGitHubUser: vi.fn(async () => ({ ok: false, httpStatus: 401, revoked: true })),
}));

vi.mock("../github/github.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/github.service")>();
  return { ...actual, fetchGitHubUser: githubAuthMocks.fetchGitHubUser };
});

vi.mock("./git.sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git.sync")>();
  return {
    ...actual,
    materializeProjectToDir: vi.fn(async () => ({ files: 1 })),
    readWorktreeFiles: vi.fn(async () => []),
    reconcileWorktreeToDb: vi.fn(async () => ({
      changedFileIds: [],
      deletedPaths: [],
      filesUpserted: 0,
      filesDeleted: 0,
    })),
  };
});

vi.mock("./git.store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git.store")>();
  return {
    ...actual,
    hasGitDir: vi.fn(async () => true),
    removeWorktreeDir: vi.fn(async () => undefined),
    ensureStorageRoot: vi.fn(async () => "/tmp/vibe-test-git"),
  };
});

const fetchDetailMock = vi.hoisted(() => vi.fn());
const createUserMock = vi.hoisted(() => vi.fn());
const createOrgMock = vi.hoisted(() => vi.fn());
const listOrgsMock = vi.hoisted(() => vi.fn());

vi.mock("../github/repos.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/repos.service")>();
  return {
    ...actual,
    fetchRepoDetail: (...args: unknown[]) =>
      (fetchDetailMock as (...a: unknown[]) => Promise<unknown>)(...args),
    createUserRepo: (...args: unknown[]) =>
      (createUserMock as (...a: unknown[]) => Promise<unknown>)(...args),
    createOrgRepo: (...args: unknown[]) =>
      (createOrgMock as (...a: unknown[]) => Promise<unknown>)(...args),
    listUserOrgs: (...args: unknown[]) =>
      (listOrgsMock as (...a: unknown[]) => Promise<unknown>)(...args),
  };
});

import { attachRemoteProject, publishProject } from "./git.service";
import { gitAttachRemoteSchema, gitPublishSchema } from "./git.validation";

const USER = { id: "u1", name: "Ravi", email: "ravi@example.com" };

function localLink() {
  return {
    id: "gr1",
    projectId: "p1",
    githubRepoId: null,
    owner: null,
    repo: null,
    fullName: null,
    defaultBranch: "main",
    currentBranch: "main",
    importedSha: null,
    importRoot: "",
    private: false,
    canRead: false,
    canWrite: false,
    canAdmin: false,
    initializedAt: new Date(),
    lastVerifiedAt: null,
  };
}

function boundLink() {
  return {
    ...localLink(),
    githubRepoId: "1",
    owner: "acme",
    repo: "demo",
    fullName: "acme/demo",
    canRead: true,
    canWrite: true,
  };
}

/** Server-verified metadata shape (normalizeRepo access included). */
function repoDetail(
  fullName = "acme/demo",
  perms = { pull: true, push: true, admin: false, maintain: false, triage: false },
) {
  const [owner, name] = fullName.split("/");
  return {
    repo: {
      id: 42,
      name,
      fullName,
      owner: { login: owner, type: "User" },
      private: true,
      fork: false,
      defaultBranch: "main",
      permissions: perms,
      access: { canRead: true, canWrite: perms.push, canAdmin: perms.admin },
    },
    scopes: "repo",
    error: null,
  };
}

function createdDto(fullName: string, canWrite = true) {
  const [owner, name] = fullName.split("/");
  return {
    id: 99,
    name,
    fullName,
    owner: { login: owner, type: "User" },
    private: true,
    fork: false,
    defaultBranch: "main",
    permissions: { pull: true, push: canWrite, admin: false, maintain: false, triage: false },
    access: { canRead: true, canWrite, canAdmin: false },
  };
}

beforeEach(() => {
  clearGitLocks();
  dbLink = localLink();
  currentOriginUrl = "https://github.com/acme/demo.git";
  vi.restoreAllMocks();
  // Defaults (restoreAllMocks clears per-test overrides set below).
  dbMocks.gitRepositoryFindUnique.mockImplementation(async () => ({ ...dbLink }));
  dbMocks.gitRepositoryUpdate.mockImplementation(async ({ data }: { data: object }) => {
    dbLink = { ...dbLink, ...data };
    return { ...dbLink };
  });
  dbMocks.gitRepositoryCreate.mockImplementation(async ({ data }: { data: object }) => {
    dbLink = { id: "gr1", projectId: "p1", ...data };
    return { ...dbLink };
  });
  dbMocks.accountFindFirst.mockResolvedValue({ accessToken: "tok", scope: "repo" });
  dbMocks.fileFindMany.mockResolvedValue([]);
  engineMocks.revparseHead.mockResolvedValue(LOCAL_SHA);
  engineMocks.currentBranch.mockResolvedValue("main");
  engineMocks.getStatus.mockResolvedValue({ branch: "main", clean: true, entries: [] });
  remoteMocks.getCloneMarker.mockResolvedValue("clone");
  remoteMocks.commitCount.mockResolvedValue(2);
  remoteMocks.getRemoteUrl.mockImplementation(async () => currentOriginUrl);
  remoteMocks.tryRevparse.mockResolvedValue(null);
  remoteMocks.lsRemoteHead.mockResolvedValue(null);
  remoteMocks.isAncestor.mockResolvedValue(false);
  remoteMocks.getUpstream.mockResolvedValue(null);
  remoteMocks.aheadBehind.mockResolvedValue({ ahead: 0, behind: 0 });
  remoteMocks.listBranches.mockResolvedValue([
    { name: "main", current: true, remote: false, commit: LOCAL_SHA },
  ]);
  fetchDetailMock.mockReset();
  fetchDetailMock.mockResolvedValue(repoDetail());
  githubAuthMocks.fetchGitHubUser.mockReset();
  githubAuthMocks.fetchGitHubUser.mockResolvedValue({ ok: false, httpStatus: 401, revoked: true });
  createUserMock.mockReset();
  createOrgMock.mockReset();
  listOrgsMock.mockReset();
  listOrgsMock.mockResolvedValue({ orgs: [], error: null });
});

describe("request validation (zod twins of the server name rules)", () => {
  it("attach requires plain owner/repo slugs", () => {
    expect(gitAttachRemoteSchema.safeParse({ owner: "acme", repo: "demo" }).success).toBe(true);
    for (const bad of [
      { owner: "a/b", repo: "demo" },
      { owner: "acme", repo: "../x" },
      { owner: "", repo: "demo" },
      { owner: "acme", repo: "a b" },
    ]) {
      expect(gitAttachRemoteSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("publish requires a valid name and optional org slug", () => {
    expect(
      gitPublishSchema.safeParse({ name: "my-project", private: true }).success,
    ).toBe(true);
    expect(
      gitPublishSchema.safeParse({ name: "my-project", private: false, organization: "myorg" })
        .success,
    ).toBe(true);
    for (const bad of [
      { name: "", private: true },
      { name: "a/b", private: true },
      { name: "x".repeat(101), private: true },
      { name: "ok", private: true, organization: "a/b" },
      { name: "ok", private: "yes" },
    ]) {
      expect(gitPublishSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("attachRemoteProject", () => {
  it("attaches an empty repository without pushing", async () => {
    remoteMocks.lsRemoteHead.mockResolvedValue(null);
    const result = await attachRemoteProject("p1", USER, { owner: "acme", repo: "demo" });
    expect(result).toMatchObject({ attached: true, empty: true, branch: "main" });
    expect(result.remote.capability).toBe("CONNECTED_WRITE");
    // Derived origin only — canonical GitHub identity, no token material.
    expect(remoteMocks.setRemoteUrl).toHaveBeenCalledWith(
      expect.any(String),
      "https://github.com/acme/demo.git",
    );
    expect(JSON.stringify(remoteMocks.setRemoteUrl.mock.calls)).not.toMatch(/tok|Bearer/);
    // Binding persisted from the verified response (never browser input).
    expect(dbLink.owner).toBe("acme");
    expect(dbLink.repo).toBe("demo");
    expect(dbLink.fullName).toBe("acme/demo");
    expect(dbLink.githubRepoId).toBe("42");
    // Attach never pushes: explicit Push is a separate user action.
    expect(remoteMocks.pushBranch).not.toHaveBeenCalled();
    expect(remoteMocks.setCloneMarker).toHaveBeenCalled();
  });

  it("stores canonical GitHub casing, not browser casing", async () => {
    await attachRemoteProject("p1", USER, { owner: "ACME", repo: "DEMO" });
    expect(dbLink.owner).toBe("acme");
    expect(dbLink.repo).toBe("demo");
  });

  it("is idempotent for the exact same repository", async () => {
    dbLink = boundLink();
    const result = await attachRemoteProject("p1", USER, { owner: "ACME", repo: "demo" });
    expect(result.attached).toBe(true);
    expect(remoteMocks.lsRemoteHead).not.toHaveBeenCalled();
    expect(remoteMocks.setRemoteUrl).not.toHaveBeenCalled();
  });

  it("refuses a different repository when one is configured", async () => {
    dbLink = boundLink();
    await expect(
      attachRemoteProject("p1", USER, { owner: "other", repo: "repo" }),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_ALREADY_CONFIGURED" });
  });

  it("requires GitHub authentication", async () => {
    dbMocks.accountFindFirst.mockResolvedValue({ accessToken: null, scope: null });
    await expect(
      attachRemoteProject("p1", USER, { owner: "acme", repo: "demo" }),
    ).rejects.toMatchObject({ code: "GIT_GITHUB_REAUTH_REQUIRED" });
    expect(remoteMocks.setRemoteUrl).not.toHaveBeenCalled();
  });

  it("rejects read-only repositories without touching the worktree", async () => {
    fetchDetailMock.mockResolvedValue(
      repoDetail("acme/demo", { pull: true, push: false, admin: false, maintain: false, triage: false }),
    );
    await expect(
      attachRemoteProject("p1", USER, { owner: "acme", repo: "demo" }),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_NOT_WRITABLE" });
    expect(remoteMocks.setRemoteUrl).not.toHaveBeenCalled();
    expect(dbLink.owner).toBeNull();
  });

  it("maps a missing repository to unavailable (no existence oracle)", async () => {
    fetchDetailMock.mockResolvedValue({ repo: null, scopes: null, error: { status: 404, rateLimited: false } });
    await expect(
      attachRemoteProject("p1", USER, { owner: "acme", repo: "demo" }),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_UNAVAILABLE" });
  });

  it("attaches when the remote is an ancestor of local (push-safe)", async () => {
    remoteMocks.lsRemoteHead.mockResolvedValue(REMOTE_SHA);
    remoteMocks.tryRevparse.mockImplementation(async (...args: unknown[]) =>
      args[1] === "origin/main" ? REMOTE_SHA : null,
    );
    remoteMocks.isAncestor.mockImplementation(async (...args: unknown[]) =>
      args[1] === REMOTE_SHA && args[2] === LOCAL_SHA,
    );
    const result = await attachRemoteProject("p1", USER, { owner: "acme", repo: "demo" });
    expect(result).toMatchObject({ attached: true, empty: false });
    expect(dbLink.fullName).toBe("acme/demo");
  });

  it("attaches when local is an ancestor of the remote (pull-safe)", async () => {
    remoteMocks.lsRemoteHead.mockResolvedValue(REMOTE_SHA);
    remoteMocks.tryRevparse.mockImplementation(async (...args: unknown[]) =>
      args[1] === "origin/main" ? REMOTE_SHA : null,
    );
    remoteMocks.isAncestor.mockImplementation(async (...args: unknown[]) =>
      args[1] === LOCAL_SHA && args[2] === REMOTE_SHA,
    );
    const result = await attachRemoteProject("p1", USER, { owner: "acme", repo: "demo" });
    expect(result.attached).toBe(true);
  });

  it("refuses unrelated history and rolls back the origin config", async () => {
    remoteMocks.lsRemoteHead.mockResolvedValue(REMOTE_SHA);
    remoteMocks.tryRevparse.mockImplementation(async (...args: unknown[]) =>
      args[1] === "origin/main" ? REMOTE_SHA : null,
    );
    remoteMocks.isAncestor.mockResolvedValue(false);
    await expect(
      attachRemoteProject("p1", USER, { owner: "acme", repo: "demo" }),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_HISTORY_CONFLICT" });
    expect(remoteMocks.removeRemote).toHaveBeenCalled();
    expect(remoteMocks.pushBranch).not.toHaveBeenCalled();
    expect(dbLink.owner).toBeNull();
  });

  it("creates a local link for never-initialized projects, then attaches", async () => {
    dbLink = {};
    dbMocks.gitRepositoryFindUnique.mockImplementation(async () => {
      return Object.keys(dbLink).length === 0 ? null : { ...dbLink };
    });
    engineMocks.getStatus.mockResolvedValue({
      branch: "main",
      clean: false,
      entries: [{ path: "a.txt", status: "added", staged: true, unstaged: false }],
    });
    engineMocks.commitStaged.mockResolvedValue({ sha: LOCAL_SHA });
    remoteMocks.getCloneMarker.mockResolvedValue(null);
    remoteMocks.lsRemoteHead.mockResolvedValue(null);
    const result = await attachRemoteProject("p1", USER, { owner: "acme", repo: "demo" });
    expect(result.attached).toBe(true);
    expect(dbLink.fullName).toBe("acme/demo");
  });
});

describe("publishProject", () => {
  it("creates, attaches, and pushes the current branch (personal)", async () => {
    currentOriginUrl = "https://github.com/acme/newthing.git";
    createUserMock.mockResolvedValue({ repo: createdDto("acme/newthing"), scopes: "repo", error: null });
    const result = await publishProject("p1", USER, { name: "newthing", private: true });
    expect(result).toMatchObject({ attached: true, created: true, fullName: "acme/newthing" });
    expect(createUserMock).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ name: "newthing", private: true }),
    );
    expect(remoteMocks.setRemoteUrl).toHaveBeenCalledWith(
      expect.any(String),
      "https://github.com/acme/newthing.git",
    );
    // Alignment marker precedes the first push (migration must not rebuild).
    const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0] as number;
    expect(order(remoteMocks.setCloneMarker)).toBeLessThan(order(remoteMocks.pushBranch));
    // Initial push goes to origin with upstream, never any force flag.
    expect(remoteMocks.pushBranch).toHaveBeenCalledWith(
      expect.any(String),
      "main",
      true,
      expect.anything(),
    );
    expect(result.push).toMatchObject({ pushed: true, branch: "main" });
    expect(result.remote.capability).toBe("CONNECTED_WRITE");
    expect(dbLink.fullName).toBe("acme/newthing");
  });

  it("creates in an organization after live membership validation", async () => {
    currentOriginUrl = "https://github.com/myorg/app.git";
    listOrgsMock.mockResolvedValue({ orgs: ["myorg"], error: null });
    createOrgMock.mockResolvedValue({ repo: createdDto("myorg/app"), scopes: "repo", error: null });
    const result = await publishProject("p1", USER, {
      name: "app",
      private: false,
      organization: "MYORG",
    });
    expect(result.fullName).toBe("myorg/app");
    expect(createOrgMock).toHaveBeenCalledWith(
      "tok",
      "myorg",
      expect.objectContaining({ name: "app", private: false }),
    );
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it("rejects organizations the user is not a member of", async () => {
    listOrgsMock.mockResolvedValue({ orgs: ["myorg"], error: null });
    await expect(
      publishProject("p1", USER, { name: "app", private: true, organization: "evil" }),
    ).rejects.toMatchObject({ code: "GITHUB_REPO_CREATE_DENIED" });
    expect(createOrgMock).not.toHaveBeenCalled();
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it("maps name collisions to already-exists", async () => {
    createUserMock.mockResolvedValue({ repo: null, scopes: null, error: { status: 422, rateLimited: false } });
    await expect(
      publishProject("p1", USER, { name: "taken", private: true }),
    ).rejects.toMatchObject({ code: "GITHUB_REPO_ALREADY_EXISTS" });
    expect(dbLink.owner).toBeNull();
  });

  it("maps creation denials without linking anything", async () => {
    createUserMock.mockResolvedValue({ repo: null, scopes: null, error: { status: 403, rateLimited: false } });
    await expect(
      publishProject("p1", USER, { name: "x", private: true }),
    ).rejects.toMatchObject({ code: "GITHUB_REPO_CREATE_DENIED" });
    expect(remoteMocks.setRemoteUrl).not.toHaveBeenCalled();
  });

  it("refuses when the project already has a remote", async () => {
    dbLink = boundLink();
    await expect(
      publishProject("p1", USER, { name: "x", private: true }),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_ALREADY_CONFIGURED" });
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it("rejects invalid names before any GitHub call", async () => {
    await expect(
      publishProject("p1", USER, { name: "a/b", private: true }),
    ).rejects.toMatchObject({ code: "GIT_OPERATION_FAILED" });
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it("requires GitHub authentication", async () => {
    dbMocks.accountFindFirst.mockResolvedValue({ accessToken: "tok", scope: "read:user" });
    await expect(
      publishProject("p1", USER, { name: "x", private: true }),
    ).rejects.toMatchObject({ code: "GIT_GITHUB_REAUTH_REQUIRED" });
  });

  it("heals a legacy NULL importRoot on publish (new repo: no wrong-path risk)", async () => {
    dbLink = { ...localLink(), importRoot: null };
    currentOriginUrl = "https://github.com/acme/newthing.git";
    createUserMock.mockResolvedValue({ repo: createdDto("acme/newthing"), scopes: "repo", error: null });
    const result = await publishProject("p1", USER, { name: "newthing", private: true });
    expect(result).toMatchObject({ attached: true, created: true, fullName: "acme/newthing" });
    expect(dbLink.importRoot).toBe("");
    expect(result.push).toMatchObject({ pushed: true, branch: "main" });
  });

  it("heals a legacy NULL importRoot when attaching an empty repository", async () => {
    dbLink = { ...localLink(), importRoot: null };
    remoteMocks.lsRemoteHead.mockResolvedValue(null);
    const result = await attachRemoteProject("p1", USER, { owner: "acme", repo: "demo" });
    expect(result).toMatchObject({ attached: true, empty: true });
    expect(dbLink.importRoot).toBe("");
    expect(dbLink.fullName).toBe("acme/demo");
  });

  it("still blocks attaching a non-empty repository with unknown importRoot", async () => {
    dbLink = { ...localLink(), importRoot: null };
    remoteMocks.lsRemoteHead.mockResolvedValue(REMOTE_SHA);
    await expect(
      attachRemoteProject("p1", USER, { owner: "acme", repo: "demo" }),
    ).rejects.toMatchObject({ code: "GIT_IMPORT_ROOT_UNKNOWN" });
    // Rollback preserved: no origin left behind, row stays local-only.
    expect(remoteMocks.removeRemote).toHaveBeenCalled();
    expect(dbLink.owner).toBeNull();
    expect(dbLink.importRoot).toBeNull();
  });
});
