// Removed: cross-file type acquisition pipeline (Bolt-style strip-down).
// Kept as no-op stubs so existing imports compile. Do not revive.

export function setActiveTemplate(_template: string): void {}

export function getPackageRoots(_packageJsonContent: string): string[] {
  return [];
}

export interface DependencyLoadResult {
  files: number;
  packages: number;
  misses: string[];
}

export async function ensureDependencyTypes(): Promise<DependencyLoadResult> {
  return { files: 0, packages: 0, misses: [] };
}

export function flushPendingDependencyTypes(): void {}
