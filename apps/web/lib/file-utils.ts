import type { ProjectFile } from "@/types/file";

export function getUniqueName(desired: string, parentId: string | null, files: ProjectFile[]): string {
  const siblings = files.filter((f) => f.parentId === parentId).map((f) => f.name.toLowerCase());
  if (!siblings.includes(desired.toLowerCase())) return desired;
  const dot = desired.lastIndexOf(".");
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  let i = 1;
  while (true) {
    const candidate = `${base} (${i})${ext}`;
    if (!siblings.includes(candidate.toLowerCase())) return candidate;
    i++;
  }
}

export function getPasteParentId(target: ProjectFile, _files: ProjectFile[]): string | null {
  // folder -> children, file -> sibling (same parent)
  if (target.isFolder) return target.id;
  return target.parentId;
}

export function getCreateParentId(target: ProjectFile | null): string | null {
  if (!target) return null;
  if (target.isFolder) return target.id;
  return target.parentId;
}

export function isDescendant(files: ProjectFile[], ancestorId: string, fileId: string): boolean {
  let cur = files.find((f) => f.id === fileId);
  while (cur?.parentId) {
    if (cur.parentId === ancestorId) return true;
    cur = files.find((f) => f.id === cur!.parentId);
  }
  return false;
}

export function collectDescendants(files: ProjectFile[], rootId: string): string[] {
  const ids = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const f of files) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        added = true;
      }
    }
  }
  return Array.from(ids);
}
