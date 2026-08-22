import type { NextFunction, Request, Response } from "express";
import { prisma, ProjectRole } from "@repo/db";

const ROLE_LEVEL: Record<ProjectRole, number> = {
  [ProjectRole.VIEWER]: 1,
  [ProjectRole.EDITOR]: 2,
  [ProjectRole.OWNER]: 3,
};

export function requireProjectAccess(
  minimumRole: ProjectRole = ProjectRole.VIEWER,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      const { projectId } = req.params;

      if (!userId) {
        return res.status(401).json({
          success: false,
          code: "INVALID_USER",
          message: "User not authenticated",
        });
      }

      if (!projectId || typeof projectId !== "string") {
        return res.status(400).json({
          success: false,
          code: "INVALID_PROJECT",
          message: "Project ID must be a valid single string",
        });
      }

      const project = await prisma.project.findUnique({
        where: {
          id: projectId,
        },
        select: {
          id: true,
          ownerId: true,
        },
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
          where: {
            projectId_userId: {
              projectId,
              userId,
            },
          },
          select: {
            role: true,
          },
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

      res.locals.projectAccess = {
        projectId,
        userId,
        role,
      };

      next();
    } catch (error) {
      console.error(error);
      next(error);
    }
  };
}
