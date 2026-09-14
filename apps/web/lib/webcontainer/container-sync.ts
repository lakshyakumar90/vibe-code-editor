/**
 * Container → DB file synchronization for terminal activity.
 *
 * The DB→container direction is one-way today (save/mirror paths); files
 * created or rewritten by the terminal (edits, `git checkout`, `restore`,
 * `reset`) must flow back through the existing File API so Monaco/Yjs/the
 * file tree converge. `.git` and other runtime metadata must NEVER become
 * File rows (see `shouldSyncPath` + the server-side `.git` name guard).
 */

import { normalizeDbPath } from "../workspace/paths";

/** Top-level segments excluded from every container scan and sync. */
export const SYNC_IGNORED_TOP: ReadonlySet<string> = new Set([
  ".git",
  ".vibe",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
]);

export const CONTAINER_SYNC_MAX_FILES = 2000;
export const CONTAINER_SYNC_MAX_BYTES_PER_FILE = 1_000_000;
export const CONTAINER_SYNC_MAX_TOTAL_BYTES = 10_000_000;

/** False for runtime metadata, absolute paths, traversals, empty rels. */
export function shouldSyncPath(rel: string): boolean {
  const norm = normalizeDbPath(rel);
  if (!norm) return false;
  if (norm.startsWith("..") || norm.includes("/../")) return false;
  const top = norm.split("/", 1)[0]!;
  if (SYNC_IGNORED_TOP.has(top)) return false;
  return true;
}

/** True when text looks binary (NUL in the sniffed head). */
export function looksBinary(content: string): boolean {
  return content.slice(0, 8000).includes("\0");
}

export interface ScannedContainerFile {
  path: string;
  content: string;
}

export interface DbFileLite {
  id: string;
  path: string;
  content: string | null;
  isFolder: boolean;
}

export interface ContainerDiff {
  created: ScannedContainerFile[];
  updated: { id: string; path: string; content: string }[];
  deleted: { id: string; path: string }[];
}

/**
 * Walk the container FS under the project root. Skips ignored dirs,
 * binaries, and oversized files. Caps total work; throws on FS errors so
 * callers can surface "sync failed" instead of silently diverging.
 */
export async function scanContainerFiles(listDir: (dir: string) => Promise<{ name: string; isFile: boolean; isDirectory: boolean }[]>, readText: (file: string) => Promise<string | null>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let totalBytes = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await listDir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (!shouldSyncPath(rel)) continue;
      if (e.isDirectory) {
        stack.push(rel);
        continue;
      }
      if (!e.isFile) continue;
      if (found.size >= CONTAINER_SYNC_MAX_FILES) return found;
      let content: string | null = null;
      try {
        content = await readText(rel);
      } catch {
        continue;
      }
      if (content === null) continue;
      if (content.length > CONTAINER_SYNC_MAX_BYTES_PER_FILE) continue;
      if (looksBinary(content)) continue;
      totalBytes += content.length;
      if (totalBytes > CONTAINER_SYNC_MAX_TOTAL_BYTES) return found;
      found.set(normalizeDbPath(rel), content);
    }
  }
  return found;
}

/**
 * Diff a container snapshot against DB file rows. Pure + unit-tested.
 * Safety: an empty container snapshot diffs to nothing (remount races must
 * never mass-delete), and mass deletions (>50% of DB files) are dropped.
 */
export function diffContainerFiles(
  container: Map<string, string>,
  dbFiles: DbFileLite[],
): ContainerDiff {
  const empty: ContainerDiff = { created: [], updated: [], deleted: [] };
  if (container.size === 0) return empty;
  const dbByPath = new Map<string, DbFileLite>();
  for (const f of dbFiles) {
    if (f.isFolder) continue;
    dbByPath.set(normalizeDbPath(f.path), f);
  }
  const diff: ContainerDiff = { created: [], updated: [], deleted: [] };
  for (const [p, content] of container) {
    const existing = dbByPath.get(p);
    if (!existing) {
      diff.created.push({ path: p, content });
    } else if ((existing.content ?? "") !== content) {
      diff.updated.push({ id: existing.id, path: p, content });
    }
    dbByPath.delete(p);
  }
  for (const [, f] of dbByPath) {
    diff.deleted.push({ id: f.id, path: f.path });
  }
  const dbFileCount = dbFiles.filter((f) => !f.isFolder).length;
  if (dbFileCount > 0 && diff.deleted.length > dbFileCount / 2) {
    diff.deleted = [];
  }
  return diff;
}

export interface FileApi {
  post<T>(url: string, body: unknown): Promise<T>;
  put<T>(url: string, body: unknown): Promise<T>;
  delete(url: string): Promise<unknown>;
}

export interface AppliedDiff {
  changedPaths: string[];
  deletedPaths: string[];
}

/**
 * Push a container diff through the File API (POST new dirs/files,
 * PUT updates, DELETE removals). Folders are created on demand from the
 * file path; orphan empty folders are left alone (never destroy).
 */
export async function applyContainerDiff(
  api: FileApi,
  projectId: string,
  dbFiles: DbFileLite[],
  diff: ContainerDiff,
): Promise<AppliedDiff> {
  const dirToId = new Map<string, string>();
  for (const f of dbFiles) {
    if (f.isFolder) dirToId.set(normalizeDbPath(f.path), f.id);
  }
  const changedPaths: string[] = [];
  const deletedPaths: string[] = [];

  async function ensureDirId(dirPath: string): Promise<string | null> {
    if (!dirPath) return null;
    const norm = normalizeDbPath(dirPath);
    const existing = dirToId.get(norm);
    if (existing) return existing;
    const slash = norm.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : norm.slice(0, slash);
    const name = slash === -1 ? norm : norm.slice(slash + 1);
    const parentId = await ensureDirId(parentPath);
    const created = await api.post<{ id: string }>(`/api/projects/${projectId}/files`, {
      name,
      parentId,
      isFolder: true,
    });
    dirToId.set(norm, created.id);
    return created.id;
  }

  const leafName = (p: string) => {
    const i = p.lastIndexOf("/");
    return i === -1 ? p : p.slice(i + 1);
  };
  const dirOf = (p: string) => {
    const i = p.lastIndexOf("/");
    return i === -1 ? "" : p.slice(0, i);
  };

  for (const c of diff.created) {
    const parentId = await ensureDirId(dirOf(c.path));
    await api.post(`/api/projects/${projectId}/files`, {
      name: leafName(c.path),
      parentId,
      isFolder: false,
      content: c.content,
    });
    changedPaths.push(c.path);
  }
  for (const u of diff.updated) {
    await api.put(`/api/projects/${projectId}/files/${u.id}`, { content: u.content });
    changedPaths.push(u.path);
  }
  for (const d of diff.deleted) {
    await api.delete(`/api/projects/${projectId}/files/${d.id}`);
    deletedPaths.push(d.path);
  }
  return { changedPaths, deletedPaths };
}
