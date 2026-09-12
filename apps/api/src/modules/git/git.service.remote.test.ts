import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitError } from "./git.errors";
import { clearGitLocks } from "./git.lock";
import type {
  CommitFileChange,
  CommitMeta,
  HistoryDiff,
  LogCommit,
  RemoteBranchInfo,
} from "./git.remote";

/**
 * Phase 4B — remote orchestration tests. Engine, persistence, collab and
 * GitHub API are mocked; transport honesty is covered in git.remote.test.ts
 * against real local bare repositories.
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

const remoteMocks = vi.hoisted(() => ({
  getCloneMarker: vi.fn(async (): Promise<string | null> => "clone"),
  commitCount: vi.fn(async (): Promise<number | null> => 5),
  fetchOrigin: vi.fn(async () => undefined),
  getRemoteUrl: vi.fn(async (): Promise<string | null> => "https://github.com/acme/demo.git"),
  listBranches: vi.fn(async (): Promise<RemoteBranchInfo[]> => []),
  getUpstream: vi.fn(async (_dir: string, _branch: string): Promise<string | null> => null),
  aheadBehind: vi.fn(async (): Promise<{ ahead: number; behind: number }> => ({ ahead: 0, behind: 0 })),
  mergeFastForward: vi.fn(async (): Promise<{ updated: boolean; newSha: string | null }> => ({ updated: false, newSha: null })),
  pushBranch: vi.fn(async () => undefined),
  createBranch: vi.fn(async () => undefined),
  checkoutBranch: vi.fn(async () => undefined),
  checkoutTracking: vi.fn(async () => undefined),
  validateBranchRef: vi.fn(async () => undefined),
  cloneRepo: vi.fn(async () => undefined),
  setCloneMarker: vi.fn(async () => undefined),
  setSparseRoot: vi.fn(async () => undefined),
  tryRevparse: vi.fn(async (_dir: string, _ref: string): Promise<string | null> => null),
  logCommits: vi.fn(async (_dir: string, _rev: string, _limit: number, _cursor: string | null): Promise<LogCommit[]> => []),
  commitMeta: vi.fn(async (_dir: string, _sha: string): Promise<CommitMeta> => ({
    sha: "",
    shortSha: "",
    message: "",
    authorName: "",
    authorEmail: "",
    timestamp: new Date(0).toISOString(),
    parents: [],
  })),
  commitFileChanges: vi.fn(async (_dir: string, _sha: string): Promise<{ parents: string[]; files: CommitFileChange[] }> => ({
    parents: [],
    files: [],
  })),
  historyFileDiff: vi.fn(async (_dir: string, _sha: string, _path: string): Promise<HistoryDiff> => ({
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

const dbMocks = vi.hoisted(() => ({
  gitRepositoryFindUnique: vi.fn(),
  gitRepositoryUpdate: vi.fn(),
  gitRepositoryCreate: vi.fn(),
  accountFindFirst: vi.fn(),
  fileFindMany: vi.fn(),
  fileUpdate: vi.fn(),
  fileCreate: vi.fn(),
  fileDelete: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  prisma: {
    gitRepository: {
      findUnique: dbMocks.gitRepositoryFindUnique,
      update: dbMocks.gitRepositoryUpdate,
      create: dbMocks.gitRepositoryCreate,
    },
    account: { findFirst: dbMocks.accountFindFirst },
    file: {
      findMany: dbMocks.fileFindMany,
      update: dbMocks.fileUpdate,
      create: dbMocks.fileCreate,
      delete: dbMocks.fileDelete,
    },
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

const collabMocks = vi.hoisted(() => ({
  getActiveEditorService: vi.fn(
    (): { getDocText: (projectId: string, fileId: string) => string | null } | null => null,
  ),
}));

vi.mock("../collab/collab.editor", () => ({
  getActiveEditorService: collabMocks.getActiveEditorService,
}));

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
vi.mock("../github/repos.service", () => ({
  fetchRepoDetail: (...args: unknown[]) => (fetchDetailMock as (...a: unknown[]) => Promise<unknown>)(...args),
}));

import {
  checkoutProjectBranch,
  createProjectBranch,
  fetchRemote,
  getCommitDetail,
  getGitHubHost,
  getHistoryDiff,
  getProjectHistory,
  getProjectStatus,
  getRemoteState,
  listProjectBranches,
  normalizeGitUrl,
  pullProject,
  pushProject,
  resolveRemoteUrl,
} from "./git.service";

const USER = { id: "u1", name: "Ravi", email: "ravi@example.com" };
const LINK = {
  id: "gr1",
  projectId: "p1",
  owner: "acme",
  repo: "demo",
  fullName: "acme/demo",
  defaultBranch: "main",
  currentBranch: "main",
  importedSha: "a".repeat(40),
  importRoot: "",
  private: false,
  canRead: true,
  canWrite: true,
  canAdmin: false,
  initializedAt: new Date(),
};

function repoDetail(perms = { pull: true, push: true, admin: false, maintain: false, triage: false }) {
  return {
    repo: {
      id: 1,
      name: "demo",
      fullName: "acme/demo",
      owner: { login: "acme", type: "User" },
      private: false,
      fork: false,
      defaultBranch: "main",
      permissions: perms,
      access: { canRead: true, canWrite: perms.push, canAdmin: perms.admin },
    },
    scopes: "repo",
    error: null,
  };
}

beforeEach(() => {
  clearGitLocks();
  vi.restoreAllMocks();
  for (const fn of Object.values(engineMocks)) (fn as ReturnType<typeof vi.fn>).mockReset();
  for (const fn of Object.values(remoteMocks)) (fn as ReturnType<typeof vi.fn>).mockReset();
  remoteMocks.getCloneMarker.mockResolvedValue("clone");
  remoteMocks.commitCount.mockResolvedValue(5);
  remoteMocks.getUpstream.mockResolvedValue(null);
  remoteMocks.aheadBehind.mockResolvedValue({ ahead: 0, behind: 0 });
  remoteMocks.listBranches.mockResolvedValue([]);
  remoteMocks.tryRevparse.mockResolvedValue(null);
  remoteMocks.logCommits.mockResolvedValue([]);
  dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK });
  dbMocks.gitRepositoryUpdate.mockImplementation(async ({ data }: { data: unknown }) => ({ ...LINK, ...(data as object) }));
  dbMocks.accountFindFirst.mockResolvedValue({ accessToken: "tok", scope: "repo" });
  dbMocks.fileFindMany.mockResolvedValue([]);
  engineMocks.revparseHead.mockResolvedValue("b".repeat(40));
  engineMocks.getStatus.mockResolvedValue({ branch: "main", clean: true, entries: [] });
  engineMocks.currentBranch.mockResolvedValue("main");
  fetchDetailMock.mockReset();
  fetchDetailMock.mockResolvedValue(repoDetail());
  eventMocks.tree.mockClear();
  eventMocks.content.mockClear();
  collabMocks.getActiveEditorService.mockReturnValue(null);
});

describe("remote capability states", () => {
  it("LOCAL_ONLY without owner/repo, never touching GitHub", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, owner: null, repo: null, fullName: null });
    const state = await getRemoteState("p1", USER);
    expect(state).toMatchObject({ capability: "LOCAL_ONLY", remote: null });
    expect(fetchDetailMock).not.toHaveBeenCalled();
  });

  it("REAUTH_REQUIRED without a usable token", async () => {
    dbMocks.accountFindFirst.mockResolvedValue(null);
    const state = await getRemoteState("p1", USER);
    expect(state.capability).toBe("REAUTH_REQUIRED");
    expect(fetchDetailMock).not.toHaveBeenCalled();
  });

  it("CONNECTED_WRITE vs CONNECTED_READONLY from live permissions", async () => {
    expect((await getRemoteState("p1", USER)).capability).toBe("CONNECTED_WRITE");
    fetchDetailMock.mockResolvedValue(repoDetail({ pull: true, push: false, admin: false, maintain: false, triage: false }));
    expect((await getRemoteState("p1", USER)).capability).toBe("CONNECTED_READONLY");
  });

  it("REMOTE_UNAVAILABLE on 404 without revealing existence", async () => {
    fetchDetailMock.mockResolvedValue({ repo: null, scopes: null, error: { status: 404, rateLimited: false } });
    const state = await getRemoteState("p1", USER);
    expect(state.capability).toBe("REMOTE_UNAVAILABLE");
  });

  it("GIT_REMOTE_MISMATCH stops operations on tampered origin", async () => {
    remoteMocks.getRemoteUrl.mockResolvedValue("https://github.com/evil/fork.git");
    await expect(getRemoteState("p1", USER)).rejects.toMatchObject({ code: "GIT_REMOTE_MISMATCH" });
  });

  it("reports importRootKnown without blocking reads", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, importRoot: null });
    const unknown = await getRemoteState("p1", USER);
    expect(unknown.importRootKnown).toBe(false);
    expect(unknown.capability).toBe("CONNECTED_WRITE");
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, importRoot: "" });
    const known = await getRemoteState("p1", USER);
    expect(known.importRootKnown).toBe(true);
    expect(known.capability).toBe("CONNECTED_WRITE");
  });

  it("legacy unknown roots block fetch/pull/push, never local reads", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, importRoot: null });
    await expect(fetchRemote("p1", USER)).rejects.toMatchObject({ code: "GIT_IMPORT_ROOT_UNKNOWN" });
    await expect(pullProject("p1", USER)).rejects.toMatchObject({ code: "GIT_IMPORT_ROOT_UNKNOWN" });
    await expect(pushProject("p1", USER)).rejects.toMatchObject({ code: "GIT_IMPORT_ROOT_UNKNOWN" });
    // Local status still works on legacy rows (identity mapping, no guessing).
    engineMocks.getStatus.mockResolvedValue({ branch: "main", clean: true, entries: [] });
    const status = await getProjectStatus("p1", USER);
    expect(status.clean).toBe(true);
  });

  it("migration refuses to rebuild around an unproven root", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, importRoot: null, initializedAt: new Date() });
    remoteMocks.getCloneMarker.mockResolvedValue(null);
    remoteMocks.commitCount.mockResolvedValue(1);
    await expect(fetchRemote("p1", USER)).rejects.toMatchObject({ code: "GIT_IMPORT_ROOT_UNKNOWN" });
    expect(remoteMocks.cloneRepo).not.toHaveBeenCalled();
  });

  it("resolveRemoteUrl derives exclusively from owner/repo + trusted host", () => {
    expect(resolveRemoteUrl({ owner: "Acme", repo: "Demo" })).toBe(
      "https://github.com/Acme/Demo.git",
    );
    expect(resolveRemoteUrl({ owner: null, repo: null })).toBeNull();
    expect(resolveRemoteUrl({ owner: "a", repo: null })).toBeNull();
    expect(normalizeGitUrl("https://github.com/Acme/Demo.git")).toBe(normalizeGitUrl("https://github.com/acme/demo"));
  });

  it("getGitHubHost accepts only bare hostnames, defaulting to github.com", async () => {
    const prev = process.env["GIT_GITHUB_HOST"];
    try {
      delete process.env["GIT_GITHUB_HOST"];
      expect(getGitHubHost()).toBe("github.com");
      process.env["GIT_GITHUB_HOST"] = "ghe.example.com";
      expect(getGitHubHost()).toBe("ghe.example.com");
      expect(resolveRemoteUrl({ owner: "a", repo: "b" })).toBe("https://ghe.example.com/a/b.git");
      for (const bad of ["https://evil.com", "evil.com/path", "evil com", "", "a".repeat(300)]) {
        process.env["GIT_GITHUB_HOST"] = bad;
        expect(getGitHubHost()).toBe("github.com");
      }
    } finally {
      if (prev === undefined) delete process.env["GIT_GITHUB_HOST"];
      else process.env["GIT_GITHUB_HOST"] = prev;
    }
  });
});

describe("permission separation (§55)", () => {
  it("IDE OWNER + GitHub read-only → local commit path unaffected, push denied", async () => {
    fetchDetailMock.mockResolvedValue(repoDetail({ pull: true, push: false, admin: false, maintain: false, triage: false }));
    await expect(pushProject("p1", USER)).rejects.toMatchObject({ code: "GIT_PUSH_DENIED" });
    expect(remoteMocks.pushBranch).not.toHaveBeenCalled();
    expect(dbMocks.gitRepositoryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ canWrite: false }),
      }),
    );
  });

  it("IDE EDITOR + GitHub write → push proceeds (IDE role enforced at routes)", async () => {
    remoteMocks.listBranches.mockResolvedValue([{ name: "main", current: true, remote: false, commit: "c" }]);
    remoteMocks.getUpstream.mockResolvedValue("origin/main");
    remoteMocks.tryRevparse.mockImplementation(async (_d: string, ref: string) =>
      ref === "HEAD" || ref === "main" ? "b".repeat(40) : null,
    );
    const result = await pushProject("p1", USER);
    expect(result).toMatchObject({ branch: "main", remote: "origin", pushed: true, ahead: 0, behind: 0 });
    expect(remoteMocks.pushBranch).toHaveBeenCalledWith(
      expect.anything(),
      "main",
      false,
      expect.anything(),
    );
  });

  it("push sets upstream only when the branch has none", async () => {
    remoteMocks.listBranches.mockResolvedValue([{ name: "feat", current: true, remote: false, commit: "c" }]);
    remoteMocks.getUpstream.mockResolvedValue(null);
    engineMocks.currentBranch.mockResolvedValue("feat");
    await pushProject("p1", USER, "feat");
    expect(remoteMocks.pushBranch).toHaveBeenCalledWith(expect.anything(), "feat", true, expect.anything());
  });
});

describe("push guards", () => {
  beforeEach(() => {
    remoteMocks.listBranches.mockResolvedValue([{ name: "main", current: true, remote: false, commit: "c" }]);
  });

  it("local-only repos cannot push", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, owner: null, repo: null });
    await expect(pushProject("p1", USER)).rejects.toMatchObject({ code: "GIT_REMOTE_UNAVAILABLE" });
  });

  it("missing token → reauth, unknown branch → not found, bad name → invalid", async () => {
    dbMocks.accountFindFirst.mockResolvedValue(null);
    await expect(pushProject("p1", USER)).rejects.toMatchObject({ code: "GIT_GITHUB_REAUTH_REQUIRED" });
    dbMocks.accountFindFirst.mockResolvedValue({ accessToken: "tok", scope: "repo" });
    await expect(pushProject("p1", USER, "ghost")).rejects.toMatchObject({ code: "GIT_BRANCH_NOT_FOUND" });
    await expect(pushProject("p1", USER, "../evil")).rejects.toMatchObject({ code: "GIT_INVALID_BRANCH" });
  });

  it("non-fast-forward rejection propagates without force", async () => {
    remoteMocks.pushBranch.mockRejectedValue(new GitError("GIT_PUSH_REJECTED", "GitHub rejected the push."));
    await expect(pushProject("p1", USER)).rejects.toMatchObject({ code: "GIT_PUSH_REJECTED" });
  });

  it("push uses only fixed origin + explicit branch (no proxy surface)", async () => {
    remoteMocks.getUpstream.mockResolvedValue("origin/main");
    remoteMocks.listBranches.mockResolvedValue([{ name: "main", current: true, remote: false, commit: "c" }]);
    await pushProject("p1", USER);
    const [dir, branch, setUpstream, env] = remoteMocks.pushBranch.mock.calls[0] as unknown[];
    expect(branch).toBe("main");
    expect(setUpstream).toBe(false);
    expect(env).not.toHaveProperty("token");
    expect(JSON.stringify(remoteMocks.pushBranch.mock.calls)).not.toMatch(/--force|--force-with-lease|-f\b/);
  });
});

describe("fetch", () => {
  it("requires auth + binding, updates refs only, reports ahead/behind", async () => {
    dbMocks.accountFindFirst.mockResolvedValue(null);
    await expect(fetchRemote("p1", USER)).rejects.toMatchObject({ code: "GIT_GITHUB_REAUTH_REQUIRED" });
    dbMocks.accountFindFirst.mockResolvedValue({ accessToken: "tok", scope: "repo" });
    dbMocks.gitRepositoryFindUnique.mockResolvedValue(null);
    await expect(fetchRemote("p1", USER)).rejects.toMatchObject({ code: "GIT_NOT_CONNECTED" });

    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK });
    remoteMocks.getUpstream.mockResolvedValue("origin/main");
    remoteMocks.aheadBehind.mockResolvedValue({ ahead: 2, behind: 1 });
    const result = await fetchRemote("p1", USER);
    expect(result).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1 });
    expect(typeof result.fetchedAt).toBe("string");
    expect(remoteMocks.fetchOrigin).toHaveBeenCalledTimes(1);
  });

  it("concurrent fetch gets 409", async () => {
    remoteMocks.fetchOrigin.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 60)));
    const first = fetchRemote("p1", USER);
    await expect(fetchRemote("p1", USER)).rejects.toMatchObject({ code: "GIT_OPERATION_IN_PROGRESS" });
    await first;
  });
});

describe("branches", () => {
  const branchList = [
    { name: "main", current: true, remote: false, commit: "c1" },
    { name: "feature/x", current: false, remote: false, commit: "c2" },
    { name: "main", current: false, remote: true, remoteName: "origin/main", commit: "c1" },
  ];

  it("lists local + remote with upstream/ahead-behind", async () => {
    remoteMocks.listBranches.mockResolvedValue(branchList);
    remoteMocks.getUpstream.mockImplementation(async (_d: string, b: string) =>
      b === "main" ? "origin/main" : null,
    );
    remoteMocks.aheadBehind.mockResolvedValue({ ahead: 1, behind: 0 });
    const result = await listProjectBranches("p1", USER);
    expect(result.current).toBe("main");
    expect(result.local.find((b) => b.name === "main")).toMatchObject({
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
    });
    expect(result.local.find((b) => b.name === "feature/x")?.upstream).toBeNull();
    expect(result.remote).toEqual([{ name: "main", remoteName: "origin/main", commit: "c1" }]);
  });

  it("create validates, rejects duplicates/unknown starts, never pushes", async () => {
    remoteMocks.listBranches.mockResolvedValue(branchList);
    await expect(createProjectBranch("p1", USER, "../evil")).rejects.toMatchObject({
      code: "GIT_INVALID_BRANCH",
    });
    await expect(createProjectBranch("p1", USER, "main")).rejects.toMatchObject({
      code: "GIT_BRANCH_EXISTS",
    });
    await expect(createProjectBranch("p1", USER, "new", "ghost")).rejects.toMatchObject({
      code: "GIT_BRANCH_NOT_FOUND",
    });
    const created = await createProjectBranch("p1", USER, "new", "main");
    expect(created).toMatchObject({ from: "main", branch: { name: "new", current: false } });
    const fromRemote = await createProjectBranch("p1", USER, "new2", "main");
    expect(fromRemote.from).toBe("main");
  });

  it("checkout requires clean editor + clean worktree, then reconciles", async () => {
    remoteMocks.listBranches.mockResolvedValue(branchList);
    engineMocks.getStatus.mockResolvedValue({
      branch: "main",
      clean: false,
      entries: [{ path: "a.txt", status: "modified", staged: false, unstaged: true }],
    });
    await expect(checkoutProjectBranch("p1", USER, "feature/x")).rejects.toMatchObject({
      code: "GIT_DIRTY_WORKTREE",
    });
    engineMocks.getStatus.mockResolvedValue({ branch: "main", clean: true, entries: [] });
    const done = await checkoutProjectBranch("p1", USER, "feature/x");
    expect(done.branch).toBe("feature/x");
    expect(done.reconciled).toBeTruthy();
    expect(eventMocks.tree).toHaveBeenCalledWith("p1");
    expect(dbMocks.gitRepositoryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currentBranch: "feature/x" }) }),
    );
  });

  it("checkout of unknown branch 404s; tracking checkout used for remote-only", async () => {
    remoteMocks.listBranches.mockResolvedValue(branchList);
    engineMocks.getStatus.mockResolvedValue({ branch: "main", clean: true, entries: [] });
    await expect(checkoutProjectBranch("p1", USER, "nope")).rejects.toMatchObject({
      code: "GIT_BRANCH_NOT_FOUND",
    });
    await expect(checkoutProjectBranch("p1", USER, "../../x")).rejects.toMatchObject({
      code: "GIT_INVALID_BRANCH",
    });
    // Remote-only branch name resolves to a tracking checkout.
    remoteMocks.listBranches.mockResolvedValue([
      { name: "main", current: true, remote: false, commit: "c1" },
      { name: "other", current: false, remote: true, remoteName: "origin/other", commit: "c9" },
    ]);
    await checkoutProjectBranch("p1", USER, "other");
    const { checkoutTracking } = remoteMocks;
    expect(checkoutTracking).toHaveBeenCalledWith(expect.anything(), "other", "other");
  });

  it("checkout blocked by unsaved Yjs state", async () => {
    remoteMocks.listBranches.mockResolvedValue(branchList);
    engineMocks.getStatus.mockResolvedValue({ branch: "main", clean: true, entries: [] });
    dbMocks.fileFindMany.mockResolvedValue([{ id: "f1", path: "a.txt", content: "saved" }]);
    collabMocks.getActiveEditorService.mockReturnValue({ getDocText: () => "unsaved" });
    await expect(checkoutProjectBranch("p1", USER, "feature/x")).rejects.toMatchObject({
      code: "GIT_DIRTY_EDITOR_STATE",
    });
  });
});

describe("pull", () => {
  beforeEach(() => {
    remoteMocks.getUpstream.mockResolvedValue("origin/main");
    engineMocks.getStatus.mockResolvedValue({ branch: "main", clean: true, entries: [] });
    dbMocks.fileFindMany.mockResolvedValue([]);
  });

  it("fast-forward pull advances, reconciles and broadcasts", async () => {
    remoteMocks.mergeFastForward.mockResolvedValue({ updated: true, newSha: "b".repeat(40) });
    remoteMocks.tryRevparse
      .mockResolvedValueOnce("a".repeat(40))
      .mockResolvedValue("b".repeat(40));
    const result = await pullProject("p1", USER);
    expect(result.pulled).toBe(true);
    expect(result.oldSha).toBe("a".repeat(40));
    expect(result.newSha).toBe("b".repeat(40));
    expect(eventMocks.tree).toHaveBeenCalledWith("p1");
  });

  it("up-to-date pull is a clean no-op", async () => {
    remoteMocks.mergeFastForward.mockResolvedValue({ updated: false, newSha: "a".repeat(40) });
    const result = await pullProject("p1", USER);
    expect(result.pulled).toBe(false);
  });

  it("diverged histories refuse with GIT_PULL_DIVERGED", async () => {
    remoteMocks.mergeFastForward.mockRejectedValue(new GitError("GIT_PULL_DIVERGED", "diverged"));
    await expect(pullProject("p1", USER)).rejects.toMatchObject({ code: "GIT_PULL_DIVERGED" });
  });

  it("dirty worktree and missing upstream block safely", async () => {
    engineMocks.getStatus.mockResolvedValue({
      branch: "main",
      clean: false,
      entries: [{ path: "a.txt", status: "modified", staged: false, unstaged: true }],
    });
    await expect(pullProject("p1", USER)).rejects.toMatchObject({ code: "GIT_DIRTY_WORKTREE" });
    engineMocks.getStatus.mockResolvedValue({ branch: "main", clean: true, entries: [] });
    remoteMocks.getUpstream.mockResolvedValue(null);
    await expect(pullProject("p1", USER)).rejects.toMatchObject({ code: "GIT_NO_UPSTREAM" });
  });
});

describe("history", () => {
  it("paginates with limit clamping and cursor validation", async () => {
    remoteMocks.listBranches.mockResolvedValue([{ name: "main", current: true, remote: false, commit: "c" }]);
    remoteMocks.logCommits.mockImplementation(async (_d: string, _r: string, limit: number) =>
      Array.from({ length: limit }, (_, i) => ({
        sha: `${i}`.padStart(40, "a"),
        shortSha: `${i}`,
        message: `m${i}`,
        authorName: "A",
        authorEmail: "a@x",
        timestamp: new Date(0).toISOString(),
        parents: [],
      })),
    );
    const page = await getProjectHistory("p1", USER, { limit: 5000 });
    expect(page.hasMore).toBe(true);
    expect(remoteMocks.logCommits).toHaveBeenCalledWith(expect.anything(), "main", 200, null);
    await expect(getProjectHistory("p1", USER, { cursor: "nope" })).rejects.toMatchObject({
      code: "GIT_COMMIT_NOT_FOUND",
    });
    await expect(getProjectHistory("p1", USER, { branch: "ghost" })).rejects.toMatchObject({
      code: "GIT_BRANCH_NOT_FOUND",
    });
  });

  it("commit detail maps monorepo paths and rejects bad SHAs", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, importRoot: "apps/web" });
    remoteMocks.getCloneMarker.mockResolvedValue("clone");
    remoteMocks.commitMeta.mockResolvedValue({
      sha: "c".repeat(40),
      shortSha: "ccccccc",
      message: "m",
      authorName: "A",
      authorEmail: "a@x",
      timestamp: new Date(0).toISOString(),
      parents: [],
    });
    remoteMocks.commitFileChanges.mockResolvedValue({
      parents: [],
      files: [
        { path: "apps/web/src/a.ts", status: "modified", additions: 1, deletions: 0, binary: false },
        { path: "apps/admin/secret.ts", status: "added", additions: 2, deletions: 0, binary: false },
      ],
    });
    const detail = await getCommitDetail("p1", USER, "c".repeat(40));
    expect(detail.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    await expect(getCommitDetail("p1", USER, "xyz")).rejects.toMatchObject({
      code: "GIT_COMMIT_NOT_FOUND",
    });
  });

  it("history diff resolves IDE paths", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, importRoot: "" });
    remoteMocks.getCloneMarker.mockResolvedValue("clone");
    remoteMocks.historyFileDiff.mockResolvedValue({
      path: "src/a.ts",
      status: "modified",
      sha: "c".repeat(40),
      isBinary: false,
      tooLarge: false,
      oldContent: "1",
      newContent: "2",
    });
    const diff = await getHistoryDiff("p1", USER, "c".repeat(40), "src/a.ts");
    expect(diff).toMatchObject({ path: "src/a.ts", sha: "c".repeat(40), staged: false });
  });
});

describe("importRoot mapping + migration", () => {
  it("status translates git paths and drops out-of-scope siblings", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, importRoot: "apps/web" });
    remoteMocks.getCloneMarker.mockResolvedValue("clone");
    engineMocks.getStatus.mockResolvedValue({
      branch: "main",
      clean: false,
      entries: [
        { path: "apps/web/src/a.ts", status: "modified", staged: false, unstaged: true },
        { path: "apps/admin/evil.ts", status: "modified", staged: false, unstaged: true },
      ],
    });
    const status = await getProjectStatus("p1", USER);
    expect(status.entries.map((e) => e.path)).toEqual(["src/a.ts"]);
    expect(status.clean).toBe(false);
  });

  it("synthetic single-commit worktree migrates to a clone on remote ops", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, importRoot: "", initializedAt: new Date() });
    remoteMocks.getCloneMarker.mockResolvedValue(null);
    remoteMocks.commitCount.mockResolvedValue(1);
    dbMocks.fileFindMany.mockResolvedValue([]);
    const result = await fetchRemote("p1", USER);
    expect(result.branch).toBe("main");
    expect(remoteMocks.cloneRepo).toHaveBeenCalledTimes(1);
  });

  it("multi-commit synthetic history refuses migration explicitly", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, importRoot: "", initializedAt: new Date() });
    remoteMocks.getCloneMarker.mockResolvedValue(null);
    remoteMocks.commitCount.mockResolvedValue(3);
    await expect(fetchRemote("p1", USER)).rejects.toMatchObject({ code: "GIT_BOOTSTRAP_FAILED" });
  });
});

describe("no arbitrary remote surface (static)", () => {
  it("service builds no user-controlled URLs/refspecs/force flags", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "git.service.ts"), "utf8");
    expect(src).not.toMatch(/--force/);
    expect(src).not.toMatch(/req\.body\.(url|remote|refspec|remoteUrl)/);
    expect(src).not.toMatch(/req\.query\.(url|remote|refspec)/);
    const remoteSrc = fs.readFileSync(path.join(__dirname, "git.remote.ts"), "utf8");
    expect(remoteSrc).not.toMatch(/--force/);
  });

  it("no request surface accepts a remote URL (controller + validation)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const file of ["git.controller.ts", "git.validation.ts", "git.routes.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src, file).not.toMatch(/remoteUrl/i);
    }
    // Service builds remote URLs ONLY from the trusted host + DB slugs:
    // no per-project URL field is read, and no user input is interpolated.
    const svc = fs.readFileSync(path.join(__dirname, "git.service.ts"), "utf8");
    expect(svc).not.toMatch(/link\.remoteUrl/);
    expect(svc).toMatch(/getGitHubHost\(\)/);
  });
});
