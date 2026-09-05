export interface DependencyState {
  packageJsonHash: string;
  installed: boolean;
  installing: boolean;
  lastInstallAt?: number;
}

export function createInitialDependencyState(): DependencyState {
  return { packageJsonHash: "", installed: false, installing: false };
}

/** Small synchronous hash (djb2) — enough to detect package.json edits. */
export function hashPackageJson(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return `djb2-${(hash >>> 0).toString(16)}`;
}
