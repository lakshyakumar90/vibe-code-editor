import { prisma, ProjectRole } from "@repo/db";

const ROLE_LEVEL: Record<ProjectRole, number> = {
  [ProjectRole.VIEWER]: 1,
  [ProjectRole.EDITOR]: 2,
  [ProjectRole.OWNER]: 3,
};

export type ProjectAccessDeniedCode = "PROJECT_NOT_FOUND" | "FORBIDDEN";

export type ProjectAccessResult =
  | { ok: true; role: ProjectRole }
  | { ok: false; code: ProjectAccessDeniedCode };

/**
 * Shared project authorization used by HTTP middleware AND the WS gateway.
 * Same semantics as `requireProjectAccess`: owner short-circuit, else
 * `projectMember` lookup, else 404/403. Minimum role defaults to VIEWER
 * (presence/rooms are read-level; editor/AI/terminal phases may require more).
 */
export async function checkProjectAccess(
  userId: string,
  projectId: string,
  minimumRole: ProjectRole = ProjectRole.VIEWER,
): Promise<ProjectAccessResult> {
  if (!userId || !projectId) {
    return { ok: false, code: "FORBIDDEN" };
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerId: true },
  });

  if (!project) {
    return { ok: false, code: "PROJECT_NOT_FOUND" };
  }

  let role: ProjectRole | null = null;
  if (project.ownerId === userId) {
    role = ProjectRole.OWNER;
  } else {
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    role = membership?.role ?? null;
  }

  if (!role || ROLE_LEVEL[role] < ROLE_LEVEL[minimumRole]) {
    return { ok: false, code: "FORBIDDEN" };
  }

  return { ok: true, role };
}
