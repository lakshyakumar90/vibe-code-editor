/**
 * WebContainer native-Git capability probe (pure helpers).
 *
 * Future-proofing: if a future WebContainer release ever ships a native `git`
 * binary, the JS git shim must disable itself and defer to the real CLI.
 * This module holds the version-parsing + shim-decision logic so it can be
 * unit-tested without booting a container.
 */

/** Result of the `git --version` runtime probe. */
export interface NativeGitProbe {
  /** True when `git --version` succeeded inside the container. */
  available: boolean;
  /** Raw version string (e.g. "git version 2.44.0"), null when unavailable. */
  version: string | null;
}

/**
 * Parse `git --version` output. Returns the trimmed version line when it
 * looks like git output, else null.
 */
export function parseGitVersion(output: string): string | null {
  const line = output.trim().split("\n", 1)[0]?.trim() ?? "";
  return /^git version \S+/.test(line) ? line.slice(0, 200) : null;
}

/**
 * Shim decision: use the JS git shim only when no native git is present.
 * A future WebContainer with native git disables the shim automatically.
 */
export function shouldUseGitShim(probe: NativeGitProbe | null): boolean {
  if (!probe) return true;
  return !probe.available;
}
