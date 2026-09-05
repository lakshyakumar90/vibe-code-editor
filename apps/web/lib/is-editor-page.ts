/** True for /dashboard/projects/<id> (the fullscreen editor). */
export function isEditorPage(pathname: string | null): boolean {
  if (!pathname) return false;
  return (
    pathname.startsWith("/dashboard/projects/") &&
    pathname.split("/").length > 3
  );
}
