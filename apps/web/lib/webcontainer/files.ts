import type { FileSystemTree } from "@webcontainer/api";
import { normalizeDbPath } from "@/lib/workspace/paths";
import type { ContainerDbFile } from "./types";

/**
 * Step 1 — DB files -> WebContainer FileSystemTree.
 * Uses file.path directly (already posix "src/App.tsx" from seeding).
 * Folders and null contents are skipped; intermediates become directories.
 */
export function toFileSystemTree(files: ContainerDbFile[]): FileSystemTree {
  const tree: FileSystemTree = {};

  for (const file of files ?? []) {
    const rel = normalizeDbPath(file.path);
    if (!rel) continue;
    const parts = rel.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (!current[part]) {
        current[part] = { directory: {} };
      } else if (!current[part].directory) {
        // A file already occupies this segment; skip nested entry.
        current = null;
        break;
      }
      current = current[part].directory;
    }
    if (!current) continue;

    const leaf = parts[parts.length - 1]!;
    current[leaf] = { file: { contents: file.content ?? "" } };
  }

  return tree;
}
