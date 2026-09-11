/**
 * Phase 1 — GitHub connection response shapes.
 *
 * These types are the API contract. They MUST never contain credentials:
 * no accessToken, refreshToken, client secret, or raw auth material.
 */

export interface GitHubUserInfo {
  id: string;
  login: string;
  avatarUrl: string | null;
  name: string | null;
  email: string | null;
}

export interface GitHubCapabilities {
  /** List/discover repositories (incl. private) + read contents. */
  repositoryRead: boolean;
  /** Write contents / push / branches (future phases). */
  repositoryWrite: boolean;
  /** Create/review/merge pull requests (future phases). */
  pullRequest: boolean;
}

export type GitHubConnectionReason =
  | "not_connected"
  | "insufficient_scope"
  | "revoked"
  | null;

export interface GitHubAuthorizationState {
  usable: boolean;
  needsReconnect: boolean;
  reason: GitHubConnectionReason;
  capabilities: GitHubCapabilities;
}

export interface GitHubStatusResponse {
  connected: boolean;
  githubUser: GitHubUserInfo | null;
  authorization: GitHubAuthorizationState;
  connection: {
    status: string;
    connectedAt: string;
    lastValidatedAt: string;
  } | null;
}
