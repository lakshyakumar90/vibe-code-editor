import { WebContainer } from "@webcontainer/api";

/**
 * Step 1 — WebContainer singleton.
 * boot() is expensive and only one instance may run per page/session,
 * so every consumer goes through this cached promise. Never call
 * WebContainer.boot() anywhere else.
 */
let containerPromise: Promise<WebContainer> | null = null;

export function getWebContainer(): Promise<WebContainer> {
  if (!containerPromise) {
    containerPromise = WebContainer.boot();
  }
  return containerPromise;
}

/** Test-only reset (e.g. after teardown). */
export function resetWebContainerCache(): void {
  containerPromise = null;
}
