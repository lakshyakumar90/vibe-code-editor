import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4A — controller tests: auth passthrough, error-code mapping,
 * and response shapes. Service logic is covered in git.service.test.ts.
 */

const serviceMocks = vi.hoisted(() => ({
  ensureRepository: vi.fn(),
  getProjectStatus: vi.fn(),
  getProjectDiff: vi.fn(),
  stageProjectPaths: vi.fn(),
  unstageProjectPaths: vi.fn(),
  stageAllPaths: vi.fn(),
  unstageAllPaths: vi.fn(),
  discardProjectPaths: vi.fn(),
  commitProject: vi.fn(),
  getRemoteState: vi.fn(),
  fetchRemote: vi.fn(),
  pullProject: vi.fn(),
  pushProject: vi.fn(),
  listProjectBranches: vi.fn(),
  createProjectBranch: vi.fn(),
  checkoutProjectBranch: vi.fn(),
  getProjectHistory: vi.fn(),
  getCommitDetail: vi.fn(),
  getHistoryDiff: vi.fn(),
}));

vi.mock("./git.service", () => serviceMocks);

import { GitError } from "./git.errors";
import { gitController } from "./git.controller";

function reqRes(params: Record<string, string> = {}, body: unknown = {}, query: Record<string, string> = {}, user: unknown = { id: "u1", name: "R", email: "r@x.com" }) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const req = { params, body, query, user } as never;
  const res = { status, json } as never;
  return { req, res, status, json };
}

beforeEach(() => {
  for (const fn of Object.values(serviceMocks)) (fn as ReturnType<typeof vi.fn>).mockReset();
});

describe("gitController", () => {
  it("maps GitError codes to stable statuses without internals", async () => {
    serviceMocks.getProjectStatus.mockRejectedValue(
      new GitError("GIT_OPERATION_IN_PROGRESS", "Another Git operation is already running"),
    );
    const { req, res, status, json } = reqRes({ projectId: "p1" });
    await gitController.getStatus(req, res);
    expect(status).toHaveBeenCalledWith(409);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ success: false, code: "GIT_OPERATION_IN_PROGRESS" });
    expect(JSON.stringify(body)).not.toMatch(/stack|spawn|ENOENT|simple-git/i);
  });

  it("maps Zod failures to 400 INVALID_INPUT", async () => {
    const { req, res, status, json } = reqRes({ projectId: "p1" }, { paths: "nope" });
    await gitController.stage(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect((json.mock.calls[0][0] as { code: string }).code).toBe("INVALID_INPUT");
    expect(serviceMocks.stageProjectPaths).not.toHaveBeenCalled();
  });

  it("returns 500 GIT_OPERATION_FAILED for unexpected errors", async () => {
    serviceMocks.commitProject.mockRejectedValue(new Error("weird db failure"));
    const { req, res, status, json } = reqRes({ projectId: "p1" }, { message: "hi" });
    await gitController.commit(req, res);
    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ success: false, code: "GIT_OPERATION_FAILED" });
    expect(JSON.stringify(body)).not.toContain("weird db failure");
  });

  it("commit responds 201 with the service payload", async () => {
    const payload = { commit: { sha: "s" }, status: { clean: true } };
    serviceMocks.commitProject.mockResolvedValue(payload);
    const { req, res, status, json } = reqRes({ projectId: "p1" }, { message: "feat" });
    await gitController.commit(req, res);
    expect(status).toHaveBeenCalledWith(201);
    expect(json.mock.calls[0][0]).toMatchObject({ success: true, data: payload });
    expect(serviceMocks.commitProject).toHaveBeenCalledWith("p1", { id: "u1", name: "R", email: "r@x.com" }, "feat");
  });

  it("diff parses the staged flag from query", async () => {
    serviceMocks.getProjectDiff.mockResolvedValue({ path: "a.txt" });
    const { req, res } = reqRes({ projectId: "p1" }, {}, { path: "a.txt", staged: "true" });
    await gitController.getDiff(req, res);
    expect(serviceMocks.getProjectDiff).toHaveBeenCalledWith("p1", expect.anything(), "a.txt", true);
  });

  it("ensure requests local-only creation for never-imported projects", async () => {
    serviceMocks.ensureRepository.mockResolvedValue({ bootstrapped: true });
    const { req, res, json } = reqRes({ projectId: "p1" });
    await gitController.ensure(req, res);
    expect(serviceMocks.ensureRepository).toHaveBeenCalledWith(
      "p1",
      { id: "u1", name: "R", email: "r@x.com" },
      { createLocalIfMissing: true },
    );
    expect(json.mock.calls[0][0]).toMatchObject({ success: true });
  });

  it("passes the session user through (never trusts body identity)", async () => {
    serviceMocks.stageAllPaths.mockResolvedValue({ clean: true });
    const { req, res } = reqRes({ projectId: "p1" }, { userId: "attacker" });
    await gitController.stageAll(req, res);
    expect(serviceMocks.stageAllPaths).toHaveBeenCalledWith("p1", { id: "u1", name: "R", email: "r@x.com" });
  });

  it("remote/fetch/pull/push delegate with session identity", async () => {
    serviceMocks.getRemoteState.mockResolvedValue({ capability: "LOCAL_ONLY" });
    serviceMocks.fetchRemote.mockResolvedValue({ branch: "main" });
    serviceMocks.pullProject.mockResolvedValue({ pulled: false });
    serviceMocks.pushProject.mockResolvedValue({ pushed: true });
    const user = { id: "u1", name: "R", email: "r@x.com" };
    let ctx = reqRes({ projectId: "p1" }, {}, {}, user);
    await gitController.getRemote(ctx.req, ctx.res);
    expect(serviceMocks.getRemoteState).toHaveBeenCalledWith("p1", user);
    ctx = reqRes({ projectId: "p1" }, {}, {}, user);
    await gitController.fetch(ctx.req, ctx.res);
    expect(serviceMocks.fetchRemote).toHaveBeenCalledWith("p1", user);
    ctx = reqRes({ projectId: "p1" }, {}, {}, user);
    await gitController.pull(ctx.req, ctx.res);
    expect(serviceMocks.pullProject).toHaveBeenCalledWith("p1", user);
    ctx = reqRes({ projectId: "p1" }, { branch: "main" }, {}, user);
    await gitController.push(ctx.req, ctx.res);
    expect(serviceMocks.pushProject).toHaveBeenCalledWith("p1", user, "main");
    ctx = reqRes({ projectId: "p1" }, {}, {}, user);
    await gitController.push(ctx.req, ctx.res);
    expect(serviceMocks.pushProject).toHaveBeenCalledWith("p1", user, undefined);
  });

  it("branch endpoints validate input before service", async () => {
    serviceMocks.createProjectBranch.mockResolvedValue({ branch: { name: "x" } });
    serviceMocks.checkoutProjectBranch.mockResolvedValue({ branch: "x" });
    serviceMocks.listProjectBranches.mockResolvedValue({ current: "main", local: [], remote: [] });
    let ctx = reqRes({ projectId: "p1" }, { name: "../evil" });
    await gitController.createBranch(ctx.req, ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(400);
    expect(serviceMocks.createProjectBranch).not.toHaveBeenCalled();
    ctx = reqRes({ projectId: "p1" }, { name: "feature/x", from: "main" });
    await gitController.createBranch(ctx.req, ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(201);
    expect(serviceMocks.createProjectBranch).toHaveBeenCalledWith(
      "p1",
      expect.anything(),
      "feature/x",
      "main",
    );
    ctx = reqRes({ projectId: "p1" }, { name: "feature/x" });
    await gitController.checkout(ctx.req, ctx.res);
    expect(serviceMocks.checkoutProjectBranch).toHaveBeenCalledWith("p1", expect.anything(), "feature/x");
    ctx = reqRes({ projectId: "p1" });
    await gitController.listBranches(ctx.req, ctx.res);
    expect(serviceMocks.listProjectBranches).toHaveBeenCalledWith("p1", expect.anything());
  });

  it("history endpoints validate sha/cursor/limit", async () => {
    serviceMocks.getProjectHistory.mockResolvedValue({ commits: [] });
    serviceMocks.getCommitDetail.mockResolvedValue({ sha: "s" });
    serviceMocks.getHistoryDiff.mockResolvedValue({ path: "a" });
    let ctx = reqRes({ projectId: "p1" }, {}, { limit: "5000", cursor: "nope" });
    await gitController.getHistory(ctx.req, ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(400);
    expect(serviceMocks.getProjectHistory).not.toHaveBeenCalled();
    ctx = reqRes({ projectId: "p1" }, {}, { limit: "10" });
    await gitController.getHistory(ctx.req, ctx.res);
    expect(serviceMocks.getProjectHistory).toHaveBeenCalledWith("p1", expect.anything(), {
      branch: undefined,
      limit: 10,
      cursor: null,
    });
    ctx = reqRes({ projectId: "p1", sha: "zzz" });
    await gitController.getCommit(ctx.req, ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(400);
    expect(serviceMocks.getCommitDetail).not.toHaveBeenCalled();
    const sha = "a".repeat(40);
    ctx = reqRes({ projectId: "p1", sha });
    await gitController.getCommit(ctx.req, ctx.res);
    expect(serviceMocks.getCommitDetail).toHaveBeenCalledWith("p1", expect.anything(), sha);
    ctx = reqRes({ projectId: "p1", sha }, {}, { path: "a.txt" });
    await gitController.getCommitDiff(ctx.req, ctx.res);
    expect(serviceMocks.getHistoryDiff).toHaveBeenCalledWith("p1", expect.anything(), sha, "a.txt");
  });

  it("route roles separate viewers from editors (static contract)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const raw = fs.readFileSync(path.join(__dirname, "git.routes.ts"), "utf8");
    // Strip comments: documentation may name future phases; only code counts.
    const src = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    // Reads: VIEWER.
    for (const route of ["git/status", "git/diff", "git/remote", "git/branches", "git/history"]) {
      expect(src).toContain(route);
    }
    // Mutations require EDITOR (fetch is intentionally read-level).
    const editorRoutes = [
      "git/ensure",
      "git/stage",
      "git/unstage",
      "git/stage-all",
      "git/unstage-all",
      "git/discard",
      "git/commit",
      "git/pull",
      "git/push",
      "git/checkout",
    ];
    for (const route of editorRoutes) {
      const idx = src.indexOf(route);
      expect(idx, route).toBeGreaterThan(-1);
      const window = src.slice(idx, idx + 400);
      expect(window).toContain("ProjectRole.EDITOR");
    }
    // No force/push --force surface, no PR/merge/rebase surface.
    expect(src).not.toMatch(/--force|pull-request|merge|rebase|cherry|revert/);
    // History diff route exists; no revert/checkout-of-commit route.
    expect(src).toContain("git/history/:sha/diff");
  });
});
