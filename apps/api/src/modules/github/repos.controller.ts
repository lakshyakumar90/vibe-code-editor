import type { Request, Response } from "express";
import { prisma } from "@repo/db";
import {
  fetchRepoDetail,
  fetchRepoTree,
  grantedRepoAccess,
  inspectRepository,
  isValidRepoSegment,
  listUserRepos,
} from "./repos.service";
import { listReposQuerySchema } from "./repos.validation";

/**
 * Phase 2 — repository discovery endpoints.
 *
 * Same invariants as Phase 1: userId is session-derived, the GitHub token
 * is read server-side from Account and never serialized, and only explicit
 * endpoints exist (no arbitrary GitHub proxy — owner/repo segments are
 * strictly validated and URLs are built from fixed templates).
 */
export const reposController = {
  /** GET /api/github/repos?page&perPage&q — paginated safe repository list. */
  async listRepos(req: Request, res: Response) {
    const userId = req.user!.id as string;
    const parsed = listReposQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        code: "INVALID_QUERY",
        message: "Invalid pagination or search parameters",
      });
    }
    const { page, perPage, q } = parsed.data;

    const account = await prisma.account.findFirst({
      where: { userId, providerId: "github" },
      select: { accessToken: true, scope: true },
    });
    if (!account?.accessToken) {
      return res.status(409).json({
        success: false,
        code: "GITHUB_NOT_CONNECTED",
        message: "Connect GitHub to browse repositories.",
      });
    }

    const result = await listUserRepos(account.accessToken, page, perPage, q ?? null);

    if (result.error) {
      if (result.error.status === 401 || result.error.status === 403) {
        return res.status(401).json({
          success: false,
          code: "GITHUB_UNAUTHORIZED",
          message: "GitHub rejected the stored authorization. Reconnect GitHub.",
        });
      }
      if (result.error.rateLimited) {
        return res.status(429).json({
          success: false,
          code: "GITHUB_RATE_LIMITED",
          message: "GitHub rate limit reached. Try again later.",
        });
      }
      return res.status(502).json({
        success: false,
        code: "GITHUB_REQUEST_FAILED",
        message: "Could not reach GitHub. Try again shortly.",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        repos: result.repos,
        meta: {
          page: q ? 1 : page,
          perPage: q ? result.repos.length : perPage,
          hasNextPage: result.hasNextPage,
          filtered: Boolean(q),
          grantedRepoAccess: grantedRepoAccess(result.scopes, account.scope),
        },
      },
    });
  },

  /** GET /api/github/repos/:owner/:repo — safe repository metadata. */
  async getRepo(req: Request, res: Response) {
    const userId = req.user!.id as string;
    const { owner, repo } = req.params;
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_REPO",
        message: "Repository owner/name must be plain GitHub slugs",
      });
    }

    const account = await prisma.account.findFirst({
      where: { userId, providerId: "github" },
      select: { accessToken: true, scope: true },
    });
    if (!account?.accessToken) {
      return res.status(409).json({
        success: false,
        code: "GITHUB_NOT_CONNECTED",
        message: "Connect GitHub to inspect repositories.",
      });
    }

    const detail = await fetchRepoDetail(account.accessToken, owner, repo);
    if (detail.error) {
      // GitHub answers 404 both for missing and for unauthorized repos:
      // never distinguish the two (no existence oracle).
      if (detail.error.status === 404) {
        return res.status(404).json({
          success: false,
          code: "REPO_NOT_FOUND",
          message: "Repository not found or not accessible with this GitHub authorization.",
        });
      }
      if (detail.error.status === 401 || detail.error.status === 403) {
        return res.status(401).json({
          success: false,
          code: "GITHUB_UNAUTHORIZED",
          message: "GitHub rejected the stored authorization. Reconnect GitHub.",
        });
      }
      if (detail.error.rateLimited) {
        return res.status(429).json({
          success: false,
          code: "GITHUB_RATE_LIMITED",
          message: "GitHub rate limit reached. Try again later.",
        });
      }
      return res.status(502).json({
        success: false,
        code: "GITHUB_REQUEST_FAILED",
        message: "Could not reach GitHub. Try again shortly.",
      });
    }

    return res.status(200).json({ success: true, data: detail.repo });
  },

  /**
   * GET /api/github/repos/:owner/:repo/inspection — minimal detection
   * input (metadata + recursive tree + candidate package.json files only).
   * Reused by Phase 3 import. Truncated trees never yield SUPPORTED.
   */
  async getInspection(req: Request, res: Response) {
    const userId = req.user!.id as string;
    const { owner, repo } = req.params;
    if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_REPO",
        message: "Repository owner/name must be plain GitHub slugs",
      });
    }

    const account = await prisma.account.findFirst({
      where: { userId, providerId: "github" },
      select: { accessToken: true, scope: true },
    });
    if (!account?.accessToken) {
      return res.status(409).json({
        success: false,
        code: "GITHUB_NOT_CONNECTED",
        message: "Connect GitHub to inspect repositories.",
      });
    }
    const token = account.accessToken;

    const detail = await fetchRepoDetail(token, owner, repo);
    if (detail.error || !detail.repo) {
      if (detail.error?.status === 404) {
        return res.status(404).json({
          success: false,
          code: "REPO_NOT_FOUND",
          message: "Repository not found or not accessible with this GitHub authorization.",
        });
      }
      if (detail.error && (detail.error.status === 401 || detail.error.status === 403)) {
        return res.status(401).json({
          success: false,
          code: "GITHUB_UNAUTHORIZED",
          message: "GitHub rejected the stored authorization. Reconnect GitHub.",
        });
      }
      return res.status(502).json({
        success: false,
        code: "GITHUB_REQUEST_FAILED",
        message: "Could not reach GitHub. Try again shortly.",
      });
    }

    const fullName = detail.repo.fullName;
    const defaultBranch = detail.repo.defaultBranch;
    const ref = detail.repo.latestSha ?? defaultBranch;
    if (!ref) {
      return res.status(502).json({
        success: false,
        code: "GITHUB_REQUEST_FAILED",
        message: "Could not determine the repository default branch.",
      });
    }

    const tree = await fetchRepoTree(token, owner, repo, ref);
    if (tree.error) {
      if (tree.error.status === 404) {
        return res.status(404).json({
          success: false,
          code: "REPO_NOT_FOUND",
          message: "Repository not found or not accessible with this GitHub authorization.",
        });
      }
      if (tree.error.status === 401 || tree.error.status === 403) {
        return res.status(401).json({
          success: false,
          code: "GITHUB_UNAUTHORIZED",
          message: "GitHub rejected the stored authorization. Reconnect GitHub.",
        });
      }
      return res.status(502).json({
        success: false,
        code: "GITHUB_REQUEST_FAILED",
        message: "Could not reach GitHub. Try again shortly.",
      });
    }

    const built = await inspectRepository(
      token,
      owner,
      repo,
      fullName,
      defaultBranch,
      detail.repo.latestSha ?? defaultBranch ?? ref,
      tree,
    );
    return res.status(200).json({ success: true, data: built.response });
  },
};
