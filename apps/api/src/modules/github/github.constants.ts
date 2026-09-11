/**
 * Phase 1 — GitHub connection constants.
 *
 * WebContainer = runtime / preview / terminal only.
 * Git = future server-side subsystem (NOT WebContainer).
 * This module never executes Git and never touches WebContainer.
 */

/**
 * Minimum classic-OAuth scope required for the roadmap after Phase 1:
 * repository discovery (incl. private read), contents write / push,
 * branch operations and pull requests. Identity scopes
 * (`read:user`, `user:email`) are Better Auth defaults and always present.
 *
 * Requested per-request in the explicit "Connect GitHub" (linkSocial) flow,
 * NOT on plain sign-in, so sign-in stays minimal.
 */
export const GITHUB_REPO_SCOPE = "repo";

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";

/** Per-request timeout for server-side GitHub identity validation. */
export const GITHUB_VALIDATION_TIMEOUT_MS = 10_000;

export const GITHUB_CONNECTION_STATUS_CONNECTED = "connected";
export const GITHUB_CONNECTION_STATUS_NEEDS_RECONNECT = "needs_reconnect";
