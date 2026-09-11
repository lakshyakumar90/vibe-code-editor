import type { Request, Response } from "express";
import { prisma } from "@repo/db";
import {
  buildGitHubStatus,
  fetchGitHubUser,
  hasRepoScope,
  resolveConnectionStatus,
  toSafeUser,
} from "./github.service";
import { GITHUB_CONNECTION_STATUS_CONNECTED } from "./github.constants";

/**
 * Phase 1 — GitHub connection endpoints.
 *
 * Invariants:
 * - Identity linkage is server-owned: userId always comes from the session
 *   (`req.user.id`). No client-supplied githubUserId/login/userId is trusted.
 * - Tokens never leave the server: read from Account, used in an
 *   Authorization header, never serialized, never logged.
 * - No Git, no import, no WebContainer interaction in this module.
 */
export const githubController = {
  /**
   * GET /api/github/status — safe connection state for the session user.
   * Performs one lightweight GET /user validation when a token exists
   * (settings page only — never on every render).
   */
  async getStatus(req: Request, res: Response) {
    const userId = req.user!.id as string;

    const account = await prisma.account.findFirst({
      where: { userId, providerId: "github" },
      select: { accountId: true, providerId: true, accessToken: true, scope: true },
    });

    const connection = await prisma.gitHubConnection.findUnique({
      where: { userId },
    });

    const token = account?.accessToken ?? null;
    const verification = token ? await fetchGitHubUser(token) : null;

    const status = buildGitHubStatus({ account, connection, verification });

    // Persist validated product state (metadata only, never credentials).
    if (token && verification?.ok) {
      const githubUser = verification.user;
      const scope = verification.oauthScopes ?? account?.scope ?? null;
      const rowStatus = resolveConnectionStatus(status.authorization);
      const now = new Date();
      const row = await prisma.gitHubConnection.upsert({
        where: { userId },
        create: {
          userId,
          githubUserId: String(githubUser.id),
          login: githubUser.login,
          avatarUrl: githubUser.avatar_url ?? null,
          name: githubUser.name ?? null,
          email: githubUser.email ?? null,
          scope,
          status: rowStatus,
          connectedAt: connection?.connectedAt ?? now,
          lastValidatedAt: now,
        },
        update: {
          githubUserId: String(githubUser.id),
          login: githubUser.login,
          avatarUrl: githubUser.avatar_url ?? null,
          name: githubUser.name ?? null,
          email: githubUser.email ?? null,
          scope,
          status: rowStatus,
          lastValidatedAt: now,
        },
      });
      status.connection = {
        status: row.status,
        connectedAt: row.connectedAt.toISOString(),
        lastValidatedAt: row.lastValidatedAt.toISOString(),
      };
    } else if (connection && token) {
      // Verification failed while a credential exists: flag for reconnect,
      // keep all metadata (do not silently delete).
      const row = await prisma.gitHubConnection.update({
        where: { userId },
        data: { status: "needs_reconnect" },
      });
      if (status.connection) status.connection.status = row.status;
    }

    return res.status(200).json({ success: true, data: status });
  },

  /**
   * POST /api/github/connect — finalize a linkSocial authorization.
   * The OAuth dance itself is Better Auth's (/link-social with `repo`
   * scope from the client); this endpoint validates the stored grant and
   * records product state. Requires an already-linked Account row.
   */
  async connect(req: Request, res: Response) {
    const userId = req.user!.id as string;

    const account = await prisma.account.findFirst({
      where: { userId, providerId: "github" },
      select: { accountId: true, providerId: true, accessToken: true, scope: true },
    });

    if (!account?.accessToken) {
      return res.status(409).json({
        success: false,
        code: "GITHUB_NOT_LINKED",
        message:
          "No GitHub authorization found. Complete the Connect GitHub flow first.",
      });
    }

    const verification = await fetchGitHubUser(account.accessToken);
    if (!verification.ok) {
      return res.status(502).json({
        success: false,
        code: verification.revoked ? "GITHUB_UNAUTHORIZED" : "GITHUB_VALIDATION_FAILED",
        message: verification.revoked
          ? "GitHub rejected the stored authorization. Reconnect GitHub."
          : "Could not reach GitHub. Try again shortly.",
      });
    }

    const effectiveScope = verification.oauthScopes ?? account.scope ?? null;
    if (!hasRepoScope(effectiveScope)) {
      return res.status(422).json({
        success: false,
        code: "INSUFFICIENT_SCOPE",
        message:
          "GitHub authorization lacks repository access. Reconnect and approve repository permissions.",
        data: { githubUser: toSafeUser(verification.user) },
      });
    }

    const githubUser = verification.user;
    const now = new Date();
    const existing = await prisma.gitHubConnection.findUnique({ where: { userId } });
    const row = await prisma.gitHubConnection.upsert({
      where: { userId },
      create: {
        userId,
        githubUserId: String(githubUser.id),
        login: githubUser.login,
        avatarUrl: githubUser.avatar_url ?? null,
        name: githubUser.name ?? null,
        email: githubUser.email ?? null,
        scope: effectiveScope,
        status: GITHUB_CONNECTION_STATUS_CONNECTED,
        connectedAt: now,
        lastValidatedAt: now,
      },
      update: {
        githubUserId: String(githubUser.id),
        login: githubUser.login,
        avatarUrl: githubUser.avatar_url ?? null,
        name: githubUser.name ?? null,
        email: githubUser.email ?? null,
        scope: effectiveScope,
        status: GITHUB_CONNECTION_STATUS_CONNECTED,
        lastValidatedAt: now,
      },
    });
    void existing;

    const status = buildGitHubStatus({
      account,
      connection: {
        status: row.status,
        connectedAt: row.connectedAt,
        lastValidatedAt: row.lastValidatedAt,
      },
      verification,
    });

    return res.status(200).json({ success: true, data: status });
  },

  /**
   * POST /api/github/disconnect — remove GitHub authorization state.
   * Deletes the GitHubConnection row and clears stored OAuth credential
   * fields on the github Account row(s). NEVER deletes the IDE User,
   * projects, files, or other accounts. Safe for GitHub-only users: the
   * Account row (sign-in linkage) is preserved; only credential fields are
   * cleared, and the next GitHub sign-in repopulates them.
   */
  async disconnect(req: Request, res: Response) {
    const userId = req.user!.id as string;

    await prisma.gitHubConnection.deleteMany({ where: { userId } });
    await prisma.account.updateMany({
      where: { userId, providerId: "github" },
      data: {
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: null,
      },
    });

    return res.status(200).json({ success: true, data: { disconnected: true } });
  },
};
