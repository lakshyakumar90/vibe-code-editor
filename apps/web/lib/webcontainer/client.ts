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
      // crossOriginIsolated can be transiently false on cold reload; wait
      // briefly for headers/isolation to settle before giving up.
      containerPromise = waitForIsolation(4000).then(() => WebContainer.boot());
      const attempt = containerPromise;
      attempt.catch(() => {
        if (containerPromise === attempt) containerPromise = null;
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

function waitForIsolation(timeoutMs: number): Promise<void> {
  if (typeof window === "undefined" || window.crossOriginIsolated !== false) return Promise.resolve();
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (window.crossOriginIsolated !== false) return resolve();
      if (Date.now() - start >= timeoutMs) {
        reject(
          new Error(
            "Browser blocked isolated execution (SharedArrayBuffer unavailable). Use Chrome/Edge on https or localhost — not private windows, blockers, or cross-origin iframes. Reload to retry.",
          ),
        );
        return;
      }
      window.setTimeout(tick, 200);
    };
    tick();
  });
}
