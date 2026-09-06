import type { NextFunction, Request, Response } from "express";
import { prisma, ProjectRole } from "@repo/db";

const ROLE_LEVEL: Record<ProjectRole, number> = {
  [ProjectRole.VIEWER]: 1,
  [ProjectRole.EDITOR]: 2,
  [ProjectRole.OWNER]: 3,
};

export interface AiRequest extends Request {
  projectRole?: ProjectRole;
}

/**
 * Project membership gate for /api/ai routes.
 *
 * Unlike requireProjectAccess (projectId from URL params), AI routes carry
 * projectId in the request body, so it is resolved from
 * body -> params -> query. Sets res.locals.projectAccess (existing
 * convention) and req.projectRole (used by the Phase 3 controller for
 * mode-specific minimum roles: agent needs EDITOR).
 */
export function requireAIProjectAccess(
  minimumRole: ProjectRole = ProjectRole.VIEWER,
) {
  return async (req: AiRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      const rawId =
        (req.body as { projectId?: unknown } | undefined)?.projectId ??
        req.params.projectId ??
        req.query.projectId;
      const projectId = typeof rawId === "string" ? rawId : undefined;

      if (!userId) {
        return res.status(401).json({
          success: false,
          code: "INVALID_USER",
          message: "User not authenticated",
        });
      }

      if (!projectId) {
        return res.status(400).json({
          success: false,
          code: "INVALID_PROJECT",
          message: "projectId is required in body, params, or query",
        });
      }

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, ownerId: true },
      });

      if (!project) {
        return res.status(404).json({
          success: false,
          code: "PROJECT_NOT_FOUND",
          message: "Project not found",
        });
      }

      let role: ProjectRole | null = null;

      if (project.ownerId === userId) {
        role = ProjectRole.OWNER;
      } else {
        const membership = await prisma.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { role: true },
        });
        role = membership?.role || null;
      }

      if (!role || ROLE_LEVEL[role] < ROLE_LEVEL[minimumRole]) {
        return res.status(403).json({
          success: false,
          code: "INSUFFICIENT_PERMISSIONS",
          message: "User does not have sufficient permissions for this project",
        });
      }

      res.locals.projectAccess = { projectId, userId, role };
      req.projectRole = role;

      next();
    } catch (error) {
      console.error(error);
      next(error);
    }
  };
}
