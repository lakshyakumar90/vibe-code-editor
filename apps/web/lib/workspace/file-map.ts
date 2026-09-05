import type { ProjectFile } from "@/types/file";
import { normalizeDbPath } from "./paths";

/** Normalized db path ("src/App.tsx") -> file id, for PUT-back to the API. */
export function buildPathToId(files: ProjectFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files ?? []) {
    if (f.isFolder) continue;
    map.set(normalizeDbPath(f.path), f.id);
  }
  return map;
}

/** Reverse lookup: file id -> normalized db path. */
export function buildIdToPath(files: ProjectFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files ?? []) {
    if (f.isFolder) continue;
    map.set(f.id, normalizeDbPath(f.path));
  }
  return map;
}
