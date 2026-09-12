/**
 * Phase 4A — stable Git API error codes.
 *
 * Controllers map GitError.code -> HTTP status; messages are user-safe
 * (no stack traces, shell commands, tokens, or file contents). Detailed
 * diagnostics go to server logs at the throw site, never to the client.
 */
export const GIT_ERROR_CODES = {
  GIT_NOT_CONNECTED: 409,
  GIT_REPOSITORY_NOT_READY: 409,
  GIT_OPERATION_IN_PROGRESS: 409,
  GIT_INVALID_PATH: 400,
  GIT_DIRTY_EDITOR_STATE: 409,
  GIT_NO_CHANGES: 422,
  GIT_COMMIT_INVALID_MESSAGE: 400,
  GIT_BOOTSTRAP_FAILED: 422,
  GIT_OPERATION_FAILED: 500,
  // Phase 4B — remote synchronization, branches, history.
  GIT_REMOTE_UNAVAILABLE: 503,
  GIT_GITHUB_REAUTH_REQUIRED: 401,
  GIT_REMOTE_MISMATCH: 409,
  GIT_REMOTE_TIMEOUT: 504,
  GIT_PUSH_REJECTED: 409,
  GIT_PUSH_DENIED: 403,
  GIT_PULL_DIVERGED: 409,
  GIT_NO_UPSTREAM: 422,
  GIT_DIRTY_WORKTREE: 409,
  GIT_BRANCH_EXISTS: 409,
  GIT_BRANCH_NOT_FOUND: 404,
  GIT_INVALID_BRANCH: 400,
  GIT_COMMIT_NOT_FOUND: 404,
  // Phase 4B hardening: legacy imports whose original root was never
  // persisted must not drive remote mutations.
  GIT_IMPORT_ROOT_UNKNOWN: 409,
} as const;

export type GitErrorCode = keyof typeof GIT_ERROR_CODES;

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: GitErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.status = GIT_ERROR_CODES[code];
    this.details = details;
  }
}
