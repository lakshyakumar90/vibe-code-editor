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
});
