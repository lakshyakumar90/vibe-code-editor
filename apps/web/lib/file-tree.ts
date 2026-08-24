import type { ProjectFile } from "@/types/file";

export interface FileTreeNode extends ProjectFile {
  children: FileTreeNode[];
}

export function buildFileTree(files: ProjectFile[]): FileTreeNode[] {
  if (!Array.isArray(files)) return []; // add
  const nodes = new Map<string, FileTreeNode>();

  for (const file of files) {
    nodes.set(file.id, {
      ...file,
      children: [],
    });
  }

  const roots: FileTreeNode[] = [];

  for (const node of nodes.values()) {
    if (!node.parentId) {
      roots.push(node);
      continue;
    }

    const parent = nodes.get(node.parentId);

    if (parent) {
      parent.children.push(node);
    } else {
      /*
       * Defensive fallback:
       * if a parent is missing, don't
       * completely hide the item.
       */
      roots.push(node);
    }
  }

  sortTree(roots);

  return roots;
}

function sortTree(nodes: FileTreeNode[]) {
  nodes.sort((a, b) => {
    if (a.isFolder !== b.isFolder) {
      return a.isFolder ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });

  for (const node of nodes) {
    sortTree(node.children);
  }
}
