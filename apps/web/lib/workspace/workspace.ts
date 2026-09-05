import type { ProjectFile } from "@/types/file";
import { normalizeDbPath } from "./paths";

export interface VirtualWorkspace {
  /** Normalized db path -> content. Folders are never stored. */
  getFile(path: string): string | undefined;
  hasFile(path: string): boolean;
  listFiles(): string[];
  updateFile(path: string, content: string): void;
  deleteFile(path: string): void;
  /** Snapshot for mount / tests. */
  getAll(): Map<string, string>;
  size(): number;
}

/**
 * Browser in-memory source of truth, built from DB ProjectFile rows.
 * Key = normalized db path ("src/App.tsx"). Folders skipped,
 * null content becomes "".
 */
export function createWorkspace(files: ProjectFile[]): VirtualWorkspace {
  const store = new Map<string, string>();

  for (const f of files ?? []) {
    if (f.isFolder) continue;
    store.set(normalizeDbPath(f.path), f.content ?? "");
  }

  return {
    getFile(path: string) {
      return store.get(normalizeDbPath(path));
    },
    hasFile(path: string) {
      return store.has(normalizeDbPath(path));
    },
    listFiles() {
      return Array.from(store.keys()).sort();
    },
    updateFile(path: string, content: string) {
      store.set(normalizeDbPath(path), content);
    },
    deleteFile(path: string) {
      store.delete(normalizeDbPath(path));
    },
    getAll() {
      return new Map(store);
    },
    size() {
      return store.size;
    },
  };
}
