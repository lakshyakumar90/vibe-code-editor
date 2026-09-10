import type { NextFunction, Request, Response } from "express";
import { ProjectRole } from "@repo/db";
import { checkProjectAccess } from "../collab/collab.access";

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

      const result = await checkProjectAccess(userId, projectId, minimumRole);

      if (!result.ok) {
        if (result.code === "PROJECT_NOT_FOUND") {
          return res.status(404).json({
            success: false,
            code: "PROJECT_NOT_FOUND",
            message: "Project not found",
          });
        }
        return res.status(403).json({
          success: false,
          code: "INSUFFICIENT_PERMISSIONS",
          message: "User does not have sufficient permissions for this project",
        });
      }

      res.locals.projectAccess = {
        projectId,
        userId,
        role: result.role,
      };

      next();
    } catch (error) {
      console.error(error);
      next(error);
    }
  };
}
