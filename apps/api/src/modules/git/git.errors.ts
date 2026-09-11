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
