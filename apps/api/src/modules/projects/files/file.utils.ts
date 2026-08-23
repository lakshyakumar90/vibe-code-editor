export function buildFilePath(name: string, parentId: string | null): string {
  if (parentId) {
    return `${parentId}/${name}`;
  }
  return name;
}
