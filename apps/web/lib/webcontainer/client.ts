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

export function getWebContainer(): Promise<WebContainer> {
  if (!containerPromise) {
    if (typeof window !== "undefined" && window.crossOriginIsolated === false) {
      throw new Error(
        "Browser blocked isolated execution (SharedArrayBuffer unavailable). Use Chrome/Edge on https or localhost — not private windows, blockers, or cross-origin iframes.",
      );
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
  if (
    typeof window !== "undefined" &&
    window.crossOriginIsolated === false
  ) {
    return "Browser blocked isolated execution (SharedArrayBuffer unavailable). Use Chrome/Edge on https or localhost — not private windows, blockers, or cross-origin iframes.";
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
