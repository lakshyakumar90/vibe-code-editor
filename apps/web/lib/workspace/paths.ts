/**
 * Step 0 — canonical path conversions (audited plan, Phase 0).
 *
 * Single source of truth:
 *   DB:          src/App.tsx            (posix, no leading slash, see ProjectFile.path)
 *   Workspace:   /project/src/App.tsx   (browser in-memory key)
 *   Monaco URI:  file:///project/src/App.tsx
 *   Container:   /src/App.tsx           (WebContainer fs root)
 */

export const WORKSPACE_PREFIX = "/project";

/** "src/App.tsx" | "/src/App.tsx" -> "src/App.tsx" */
export function normalizeDbPath(p: string): string {
  return p.replace(/^\/+/, "");
}

/** "src/App.tsx" -> "/project/src/App.tsx" */
export function dbPathToWorkspace(p: string): string {
  return `${WORKSPACE_PREFIX}/${normalizeDbPath(p)}`;
}

/** "src/App.tsx" -> "file:///project/src/App.tsx" (stable Monaco model URI) */
export function workspaceToMonacoUri(p: string): string {
  return `file://${dbPathToWorkspace(p)}`;
}

/** "src/App.tsx" -> "/src/App.tsx" (WebContainer fs path) */
export function workspaceToContainerPath(p: string): string {
  return `/${normalizeDbPath(p)}`;
}

/** "/project/src/App.tsx" -> "src/App.tsx" */
export function workspaceToDbPath(p: string): string {
  const stripped = p.startsWith(WORKSPACE_PREFIX)
    ? p.slice(WORKSPACE_PREFIX.length)
    : p;
  return normalizeDbPath(stripped);
}
