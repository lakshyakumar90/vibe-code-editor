// Removed: tsconfig-driven compilerOptions mirroring (Bolt-style strip-down).
// Kept as no-op stubs so existing imports compile. Do not revive.
import type { VirtualWorkspace } from "@/lib/workspace/workspace";

export interface LoadedProjectTsconfig {
  found: boolean;
  compilerOptions: Record<string, unknown>;
  sourceFiles: string[];
}

export function loadProjectTsconfig(_workspace: VirtualWorkspace): LoadedProjectTsconfig {
  return { found: false, compilerOptions: {}, sourceFiles: [] };
}
