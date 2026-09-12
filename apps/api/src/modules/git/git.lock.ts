import { AsyncLocalStorage } from "node:async_hooks";
import { GitError } from "./git.errors";

/**
 * Phase 4A — per-project Git operation lock (process-local).
 *
 * One mutating Git operation per project at a time. Concurrent attempts
 * get 409 GIT_OPERATION_IN_PROGRESS (never queued — the UI retries on
 * user action). Pure reads (status/diff) bypass the lock.
 *
 * NOTE: process-local only. A multi-instance deployment needs a
 * distributed lock (Redis) before horizontal scaling; see module README.
 */
const locks = new Map<string, { label: string; since: number }>();

/**
 * Phase 4B — reentrancy scope. Service functions wrap their whole body in
 * `withProjectGitLock`, and helpers like `ensureRepository` (bootstrap) or
 * clone-migration may acquire the same project lock deeper in the SAME
 * async call chain. Reentry within one chain is safe (single logical op);
 * concurrent chains still get 409.
 */
const lockContext = new AsyncLocalStorage<Set<string>>();

export function isGitLocked(projectId: string): boolean {
  return locks.has(projectId);
}

/** For tests only. */
export function clearGitLocks(): void {
  locks.clear();
}

export async function withProjectGitLock<T>(
  projectId: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Reentrant within one async chain (e.g. stage → ensure → bootstrap):
  // the inner acquisition is part of the same logical operation.
  const held = lockContext.getStore();
  if (held?.has(projectId)) {
    return fn();
  }
  // Synchronous check-and-set: no await precedes it, so concurrent
  // callers in the same tick cannot both acquire.
  if (locks.has(projectId)) {
    const current = locks.get(projectId)!;
    throw new GitError("GIT_OPERATION_IN_PROGRESS", "Another Git operation is already running for this project", {
      projectId,
      currentOperation: current.label,
    });
  }
  locks.set(projectId, { label, since: Date.now() });
  const scope = new Set(held ?? []);
  scope.add(projectId);
  try {
    return await lockContext.run(scope, fn);
  } finally {
    // Only release our own acquisition.
    if (locks.get(projectId)?.label === label) {
      locks.delete(projectId);
    }
  }
}
