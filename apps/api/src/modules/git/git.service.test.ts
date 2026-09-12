import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitError } from "./git.errors";
import { clearGitLocks } from "./git.lock";

/**
 * Phase 4A — service tests with mocked engine + persistence.
 * Real-git behavior is covered in git.engine.test.ts; here we verify
 * orchestration: bootstrap rules, guards, reconcile, error mapping.
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
  getCloneMarker: vi.fn(async () => null),
  getUpstream: vi.fn(async () => null),
  aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })),
}));

vi.mock("./git.remote", () => remoteMocks);

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
    account: { findFirst: dbMocks.accountFindFirst },
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
    readWorktreeFiles: vi.fn(async (_dir: string, paths: string[]) =>
      paths.map((p) => ({ path: p, content: "restored-content", missing: false })),
    ),
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

import {
  commitProject,
  discardProjectPaths,
  ensureRepository,
  getProjectDiff,
  getProjectStatus,
  stageAllPaths,
  stageProjectPaths,
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
  initializedAt: new Date(),
};

function cleanStatus() {
  return { branch: "main", clean: true, entries: [] };
}

beforeEach(() => {
  clearGitLocks();
  vi.restoreAllMocks();
  for (const fn of Object.values(engineMocks)) (fn as ReturnType<typeof vi.fn>).mockReset();
  dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK });
  dbMocks.gitRepositoryUpdate.mockImplementation(async ({ data }: { data: unknown }) => ({ ...LINK, ...(data as object) }));
  dbMocks.accountFindFirst.mockResolvedValue(null);
  dbMocks.gitRepositoryCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "gr-new",
    initializedAt: null,
    owner: null,
    repo: null,
    fullName: null,
    importedSha: null,
    defaultBranch: "main",
    currentBranch: "main",
    ...data,
  }));
  dbMocks.fileFindMany.mockResolvedValue([]);
  engineMocks.revparseHead.mockResolvedValue("b".repeat(40));
  engineMocks.getStatus.mockResolvedValue(cleanStatus());
  engineMocks.currentBranch.mockResolvedValue("main");
  eventMocks.tree.mockClear();
  eventMocks.content.mockClear();
  fileRepoMocks.getFileByPath.mockReset();
  fileRepoMocks.updateFile.mockReset();
  fileRepoMocks.deleteFile.mockReset();
  fileRepoMocks.createFile.mockReset();
  collabMocks.getActiveEditorService.mockReturnValue(null);
});

describe("ensureRepository", () => {
  it("rejects projects with no GitRepository", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue(null);
    await expect(ensureRepository("p1", USER)).rejects.toMatchObject({ code: "GIT_NOT_CONNECTED" });
  });

  it("skips bootstrap when already initialized with a valid HEAD", async () => {
    const result = await ensureRepository("p1", USER);
    expect(result.bootstrapped).toBe(false);
    expect(result.head).toBe("b".repeat(40));
    expect(engineMocks.initRepo).not.toHaveBeenCalled();
  });

  it("refuses a branch-name fallback as a SHA without GitHub resolution", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, importedSha: "main", initializedAt: null });
    await expect(ensureRepository("p1", USER)).rejects.toMatchObject({ code: "GIT_BOOTSTRAP_FAILED" });
    expect(engineMocks.initRepo).not.toHaveBeenCalled();
  });

  it("bootstraps from File rows and records initialization", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue({ ...LINK, initializedAt: null });
    engineMocks.commitStaged.mockResolvedValue({ sha: "c".repeat(40) });
    const result = await ensureRepository("p1", USER);
    expect(result.bootstrapped).toBe(true);
    expect(engineMocks.initRepo).toHaveBeenCalled();
    expect(engineMocks.stageAll).toHaveBeenCalled();
    expect(engineMocks.commitStaged).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Import acme/demo@aaaaaaa"),
      expect.anything(),
    );
    expect(dbMocks.gitRepositoryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "gr1" } }),
    );
  });

  it("creates a local-only binding on explicit Initialize (no GitHub needed)", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue(null);
    engineMocks.commitStaged.mockResolvedValue({ sha: "c".repeat(40) });
    const result = await ensureRepository("p1", USER, { createLocalIfMissing: true });
    expect(result.bootstrapped).toBe(true);
    expect(dbMocks.gitRepositoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: "p1" }),
      }),
    );
    // Local init: plain message, no remote, no GitHub resolution attempted.
    expect(engineMocks.commitStaged).toHaveBeenCalledWith(
      expect.anything(),
      "Initial commit",
      expect.anything(),
    );
    expect(engineMocks.initRepo).toHaveBeenCalledWith(
      expect.anything(),
      "main",
      null,
      expect.anything(),
    );
    expect(dbMocks.accountFindFirst).not.toHaveBeenCalled();
  });

  it("reads never auto-create: status without a link stays not-connected", async () => {
    dbMocks.gitRepositoryFindUnique.mockResolvedValue(null);
    await expect(getProjectStatus("p1", USER)).rejects.toMatchObject({ code: "GIT_NOT_CONNECTED" });
    expect(dbMocks.gitRepositoryCreate).not.toHaveBeenCalled();
    expect(engineMocks.initRepo).not.toHaveBeenCalled();
  });
});

describe("status / diff", () => {
  it("caps entries with truncated metadata instead of false-clean", async () => {
    const entries = Array.from({ length: 2500 }, (_, i) => ({
      path: `f${i}.txt`,
      status: "modified" as const,
      staged: false,
      unstaged: true,
    }));
    engineMocks.getStatus.mockResolvedValue({ branch: "main", clean: true, entries });
    const status = await getProjectStatus("p1", USER);
    expect(status.truncated).toBe(true);
    expect(status.totalCount).toBe(2500);
    expect(status.entries).toHaveLength(2000);
    expect(status.clean).toBe(false);
  });

  it("rejects diff for paths without changes", async () => {
    engineMocks.diffFile.mockRejectedValue(new GitError("GIT_INVALID_PATH", "File has no Git changes"));
    await expect(getProjectDiff("p1", USER, "clean.txt", false)).rejects.toMatchObject({
      code: "GIT_INVALID_PATH",
    });
  });
});

describe("stage", () => {
  it("rejects unknown and hostile paths before touching git", async () => {
    engineMocks.getStatus.mockResolvedValue({
      branch: "main",
      clean: false,
      entries: [{ path: "a.txt", status: "modified", staged: false, unstaged: true }],
    });
    await expect(stageProjectPaths("p1", USER, ["nope.txt"])).rejects.toMatchObject({
      code: "GIT_INVALID_PATH",
    });
    await expect(stageProjectPaths("p1", USER, ["../evil"])).rejects.toMatchObject({
      code: "GIT_INVALID_PATH",
    });
    expect(engineMocks.stagePaths).not.toHaveBeenCalled();
  });
});

describe("discard", () => {
  function modifiedStatus() {
    engineMocks.getStatus.mockResolvedValue({
      branch: "main",
      clean: false,
      entries: [{ path: "a.txt", status: "modified", staged: false, unstaged: true }],
    });
  }

  it("refuses untracked files (never implicitly deletes)", async () => {
    engineMocks.getStatus.mockResolvedValue({
      branch: "main",
      clean: false,
      entries: [{ path: "new.txt", status: "untracked", staged: false, unstaged: true }],
    });
    await expect(discardProjectPaths("p1", USER, ["new.txt"])).rejects.toMatchObject({
      code: "GIT_INVALID_PATH",
    });
    expect(engineMocks.discardPaths).not.toHaveBeenCalled();
  });

  it("blocks on unsaved editor state", async () => {
    modifiedStatus();
    fileRepoMocks.getFileByPath.mockResolvedValue({ id: "f1", path: "a.txt", isFolder: false, content: "saved" });
    collabMocks.getActiveEditorService.mockReturnValue({
      getDocText: () => "unsaved-typing",
    });
    await expect(discardProjectPaths("p1", USER, ["a.txt"])).rejects.toMatchObject({
      code: "GIT_DIRTY_EDITOR_STATE",
    });
    expect(engineMocks.discardPaths).not.toHaveBeenCalled();
  });

  it("reconciles DB rows, preserves ids, and emits sync hints", async () => {
    modifiedStatus();
    fileRepoMocks.getFileByPath.mockResolvedValue({ id: "f1", path: "a.txt", isFolder: false });
    fileRepoMocks.updateFile.mockResolvedValue({ id: "f1" });
    engineMocks.discardPaths.mockResolvedValue([{ path: "a.txt", outcome: "restored" }]);
    const result = await discardProjectPaths("p1", USER, ["a.txt"]);
    expect(result.restored).toEqual(["a.txt"]);
    expect(fileRepoMocks.updateFile).toHaveBeenCalledWith("f1", "p1", {
      content: "restored-content",
      updatedByUserId: "u1",
    });
    expect(eventMocks.tree).toHaveBeenCalledWith("p1");
    expect(eventMocks.content).toHaveBeenCalledWith("p1", ["f1"]);
    expect(result.status).toBeTruthy();
  });

  it("recreates rows for files restored from HEAD but missing in DB", async () => {
    modifiedStatus();
    fileRepoMocks.getFileByPath.mockResolvedValue(null);
    fileRepoMocks.createFile.mockResolvedValue({ id: "f-new" });
    engineMocks.discardPaths.mockResolvedValue([{ path: "a.txt", outcome: "restored" }]);
    const result = await discardProjectPaths("p1", USER, ["a.txt"]);
    expect(result.restored).toEqual(["a.txt"]);
    expect(fileRepoMocks.createFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", path: "a.txt", content: "restored-content" }),
    );
    expect(eventMocks.content).toHaveBeenCalledWith("p1", ["f-new"]);
  });
});

describe("commit", () => {
  it("validates the message before locking git", async () => {
    await expect(commitProject("p1", USER, "   ")).rejects.toMatchObject({
      code: "GIT_COMMIT_INVALID_MESSAGE",
    });
    await expect(commitProject("p1", USER, "x".repeat(2001))).rejects.toMatchObject({
      code: "GIT_COMMIT_INVALID_MESSAGE",
    });
  });

  it("refuses to commit with nothing staged", async () => {
    engineMocks.getStatus.mockResolvedValue({
      branch: "main",
      clean: false,
      entries: [{ path: "a.txt", status: "modified", staged: false, unstaged: true }],
    });
    await expect(commitProject("p1", USER, "msg")).rejects.toMatchObject({ code: "GIT_NO_CHANGES" });
    expect(engineMocks.commitStaged).not.toHaveBeenCalled();
  });

  it("commits staged changes and returns metadata without tokens", async () => {
    engineMocks.getStatus.mockResolvedValue({
      branch: "main",
      clean: false,
      entries: [{ path: "a.txt", status: "modified", staged: true, unstaged: false }],
    });
    engineMocks.commitStaged.mockResolvedValue({
      sha: "d".repeat(40),
      message: "msg",
      authorName: "Ravi",
      authorEmail: "ravi@example.com",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const result = await commitProject("p1", USER, "msg");
    expect(result.commit.sha).toBe("d".repeat(40));
    expect(result.commit.changedFiles).toEqual(["a.txt"]);
    expect(JSON.stringify(result)).not.toMatch(/token|secret|bearer/i);
  });

  it("second concurrent mutation gets 409", async () => {
    engineMocks.getStatus.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(cleanStatus()), 50),
        ),
    );
    const first = stageAllPaths("p1", USER);
    await expect(stageAllPaths("p1", USER)).rejects.toMatchObject({ code: "GIT_OPERATION_IN_PROGRESS" });
    await first;
  });
});
