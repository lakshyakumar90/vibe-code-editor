import {
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  GITHUB_REPO_SCOPE,
  GITHUB_VALIDATION_TIMEOUT_MS,
} from "./github.constants";
import type {
  GitHubAuthorizationState,
  GitHubCapabilities,
  GitHubConnectionReason,
  GitHubStatusResponse,
  GitHubUserInfo,
} from "./github.types";

export type GitHubFetch = typeof fetch;

export interface GitHubApiUser {
  id: number | string;
  login: string;
  avatar_url?: string | null;
  name?: string | null;
  email?: string | null;
}

export type GitHubVerification =
  | {
      ok: true;
      user: GitHubApiUser;
      /** Granted scopes from `x-oauth-scopes`, or null when absent. */
      oauthScopes: string | null;
    }
  | { ok: false; httpStatus: number; revoked: boolean };

/**
 * Split a stored/provided scope string ("a,b", "a b") into lowercase tokens.
 * Pure — unit-tested.
 */
export function parseScopeList(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return scope
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True when the granted scope set includes repository access. Pure. */
export function hasRepoScope(scope: string | null | undefined): boolean {
  return parseScopeList(scope).includes(GITHUB_REPO_SCOPE.toLowerCase());
}

const NO_CAPABILITIES: GitHubCapabilities = {
  repositoryRead: false,
  repositoryWrite: false,
  pullRequest: false,
};

const FULL_CAPABILITIES: GitHubCapabilities = {
  repositoryRead: true,
  repositoryWrite: true,
  pullRequest: true,
};

/**
 * Lightweight server-side identity validation: GET /user with the stored
 * OAuth access token. Uses `x-oauth-scopes` (authoritative granted scopes
 * for classic OAuth Apps) with the stored Account.scope as fallback.
 *
 * The token joystick never leaves the server: callers pass it in, this
 * function only attaches it to an Authorization header. It is never logged
 * and never included in any return value.
 */
export async function fetchGitHubUser(
  accessToken: string,
  fetchImpl: GitHubFetch = fetch,
): Promise<GitHubVerification> {
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API_BASE}/user`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "vibe-code-editor",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(GITHUB_VALIDATION_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, httpStatus: 0, revoked: false };
  }

  if (!response.ok) {
    const revoked = response.status === 401 || response.status === 403;
    return { ok: false, httpStatus: response.status, revoked };
  }

  let user: GitHubApiUser;
  try {
    user = (await response.json()) as GitHubApiUser;
  } catch {
    return { ok: false, httpStatus: 502, revoked: false };
  }
  if (!user || user.id === undefined || !user.login) {
    return { ok: false, httpStatus: 502, revoked: false };
  }
  const oauthScopes = response.headers?.get("x-oauth-scopes") ?? null;
  return { ok: true, user, oauthScopes };
}

export interface StoredGitHubAccount {
  accountId: string;
  providerId: string;
  accessToken: string | null;
  scope: string | null;
}

export interface StoredGitHubConnection {
  status: string;
  connectedAt: Date;
  lastValidatedAt: Date;
}

export interface StatusBuildInput {
  account: StoredGitHubAccount | null;
  connection: StoredGitHubConnection | null;
  verification: GitHubVerification | null;
}

/**
 * Map stored account + connection + live verification to the SAFE public
 * status contract. Pure — unit-tested. Output keys are fixed; credentials
 * can never leak because they are never copied to the result.
 */
export function buildGitHubStatus(input: StatusBuildInput): GitHubStatusResponse {
  const { account, connection, verification } = input;
  const disconnected: GitHubStatusResponse = {
    connected: false,
    githubUser: null,
    authorization: {
      usable: false,
      needsReconnect: false,
      reason: "not_connected",
      capabilities: { ...NO_CAPABILITIES },
    },
    connection: connection
      ? {
          status: connection.status,
          connectedAt: connection.connectedAt.toISOString(),
          lastValidatedAt: connection.lastValidatedAt.toISOString(),
        }
      : null,
  };

  const token = account?.accessToken ?? null;
  if (!token) {
    if (connection) {
      // Product state says linked but no usable credential (e.g. cleared
      // on disconnect or removed externally): needs attention, keep metadata.
      return {
        ...disconnected,
        connected: true,
        authorization: {
          usable: false,
          needsReconnect: true,
          reason: "revoked",
          capabilities: { ...NO_CAPABILITIES },
        },
      };
    }
    return disconnected;
  }

  if (!verification || !verification.ok) {
    const revoked = verification ? verification.revoked : false;
    return {
      ...disconnected,
      connected: true,
      authorization: {
        usable: false,
        needsReconnect: true,
        // Network/transport failures are transient: surface as revoked-like
        // "needs attention" without claiming the grant is gone.
        reason: "revoked",
        capabilities: { ...NO_CAPABILITIES },
      },
      // Preserve the stored row timestamps when present.
      connection: disconnected.connection,
    };
  }

  // Prefer authoritative granted scopes from GitHub; fall back to stored.
  const effectiveScope = verification.oauthScopes ?? account?.scope ?? null;
  if (!hasRepoScope(effectiveScope)) {
    const githubUser = toSafeUser(verification.user);
    return {
      connected: true,
      githubUser,
      authorization: {
        usable: false,
        needsReconnect: true,
        reason: "insufficient_scope",
        capabilities: { ...NO_CAPABILITIES },
      },
      connection: disconnected.connection,
    };
  }

  return {
    connected: true,
    githubUser: toSafeUser(verification.user),
    authorization: {
      usable: true,
      needsReconnect: false,
      reason: null,
      capabilities: { ...FULL_CAPABILITIES },
    },
    connection: disconnected.connection,
  };
}

/** Strip a GitHub API user to the safe public subset. Pure. */
export function toSafeUser(user: GitHubApiUser): GitHubUserInfo {
  return {
    id: String(user.id),
    login: user.login,
    avatarUrl: user.avatar_url ?? null,
    name: user.name ?? null,
    email: user.email ?? null,
  };
}

/**
 * Resolve the connection-row status to persist after a status evaluation.
 * Pure — keeps controller logic auditable.
 */
export function resolveConnectionStatus(authorization: GitHubAuthorizationState): string {
  return authorization.usable ? "connected" : "needs_reconnect";
}

export type { GitHubConnectionReason };
