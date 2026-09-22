import { WebContainer } from "@webcontainer/api";

/**
 * Step 1 — WebContainer singleton.
 * boot() is expensive and only one instance may run per page/session,
 * so every consumer goes through this cached promise. Never call
 * WebContainer.boot() anywhere else.
 *
 * A REJECTED boot is dropped from the cache so retries actually retry —
 * previously the first flake poisoned every later call until reload.
 */
let containerPromise: Promise<WebContainer> | null = null;

export function isCrossOriginIsolated(): boolean {
  if (typeof window === "undefined") return false;
  // crossOriginIsolated is undefined on non-secure contexts / old browsers —
  // treat anything not explicitly `true` as not-isolated.
  return window.crossOriginIsolated === true;
}

const ISOLATION_HELP =
  "Browser blocked isolated execution (SharedArrayBuffer unavailable). Use Chrome/Edge on https or localhost — not private windows, blockers, or cross-origin iframes. Then restart `pnpm --filter web dev` so the COOP/COEP headers apply.";

export function getWebContainer(): Promise<WebContainer> {
  if (!containerPromise) {
    if (!isCrossOriginIsolated()) {
      // Return (not throw) a rejected promise so callers' try/catch +
      // retry logic works — a synchronous throw poisoned boot flows
      // that only handled async rejections.
      containerPromise = Promise.reject(new Error(ISOLATION_HELP));
      const failed = containerPromise;
      failed.catch(() => {
        if (containerPromise === failed) containerPromise = null;
      });
      return containerPromise;
    }
    const attempt = WebContainer.boot();
    containerPromise = attempt;
    attempt.catch(() => {
      if (containerPromise === attempt) containerPromise = null;
    });
  }
  return containerPromise;
}

/** Human-readable boot failure (surfaced in Preview + terminal). */
export function describeBootFailure(err: unknown): string {
  if (!isCrossOriginIsolated()) {
    return ISOLATION_HELP;
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/failed to fetch|network|load|cdn|import\(|chunk/i.test(msg)) {
    return `Couldn't load the runtime from the network: ${msg}`;
  }
  return msg || "Boot failed";
}

/** Test-only reset (e.g. after teardown). */
export function resetWebContainerCache(): void {
  containerPromise = null;
}
