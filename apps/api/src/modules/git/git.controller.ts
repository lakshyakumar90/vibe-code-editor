import type { Request, Response } from "express";
import { z } from "zod";
import { GitError } from "./git.errors";
import {
  commitProject,
  discardProjectPaths,
  ensureRepository,
  getProjectDiff,
  getProjectStatus,
  stageAllPaths,
  stageProjectPaths,
  unstageAllPaths,
  unstageProjectPaths,
} from "./git.service";
import { gitCommitSchema, gitDiffQuerySchema, gitPathsSchema } from "./git.validation";

/**
 * Phase 4A — Source Control endpoints.
 *
 * Auth: `authenticate` + `requireProjectAccess` run in routes
 * (VIEWER for status/diff, EDITOR for mutations). Identity always comes
 * from `req.user`. GitError codes map to stable HTTP statuses; nothing
 * else leaks (no stack traces, commands, or tokens).
 */
function sessionUser(req: Request): { id: string; name?: string | null; email?: string | null } {
  return {
    id: String(req.user?.id ?? ""),
    name: req.user?.name ?? null,
    email: req.user?.email ?? null,
  };
}

function sendGitError(res: Response, err: unknown): void {
  if (err instanceof GitError) {
    res.status(err.status).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ success: false, code: "INVALID_INPUT", message: "Invalid request", details: err.issues });
    return;
  }
  console.error("[git:controller]", err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300));
  res.status(500).json({ success: false, code: "GIT_OPERATION_FAILED", message: "Git operation failed" });
}

export const gitController = {
  async ensure(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      // Explicit Initialize action: creates a local-only binding when the
      // project was never imported from GitHub.
      const result = await ensureRepository(projectId as string, sessionUser(req), {
        createLocalIfMissing: true,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      sendGitError(res, err);
    }
  },

  async getStatus(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      const status = await getProjectStatus(projectId as string, sessionUser(req));
      res.json({ success: true, data: status });
    } catch (err) {
      sendGitError(res, err);
    }
  },

  async getDiff(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      const query = gitDiffQuerySchema.parse(req.query);
      const diff = await getProjectDiff(projectId as string, sessionUser(req), query.path, query.staged);
      res.json({ success: true, data: diff });
    } catch (err) {
      sendGitError(res, err);
    }
  },

  async stage(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      const input = gitPathsSchema.parse(req.body);
      const status = await stageProjectPaths(projectId as string, sessionUser(req), input.paths);
      res.json({ success: true, data: status });
    } catch (err) {
      sendGitError(res, err);
    }
  },

  async unstage(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      const input = gitPathsSchema.parse(req.body);
      const status = await unstageProjectPaths(projectId as string, sessionUser(req), input.paths);
      res.json({ success: true, data: status });
    } catch (err) {
      sendGitError(res, err);
    }
  },

  async stageAll(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      const status = await stageAllPaths(projectId as string, sessionUser(req));
      res.json({ success: true, data: status });
    } catch (err) {
      sendGitError(res, err);
    }
  },

  async unstageAll(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      const status = await unstageAllPaths(projectId as string, sessionUser(req));
      res.json({ success: true, data: status });
    } catch (err) {
      sendGitError(res, err);
    }
  },

  async discard(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      const input = gitPathsSchema.parse(req.body);
      const result = await discardProjectPaths(projectId as string, sessionUser(req), input.paths);
      res.json({ success: true, data: result });
    } catch (err) {
      sendGitError(res, err);
    }
  },

  async commit(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      const input = gitCommitSchema.parse(req.body);
      const result = await commitProject(projectId as string, sessionUser(req), input.message);
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      sendGitError(res, err);
    }
  },
};
