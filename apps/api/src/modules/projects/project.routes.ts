import { authenticate } from "@repo/auth";
import { ProjectRole } from "@repo/db";
import { Router } from "express";
import { requireProjectAccess } from "./project.middleware";
import { projectController } from "./project.controller";

const router = Router();

router.use(authenticate);

router.post("/create", projectController.createProject);
router.get("/", projectController.getAllProjects);
router.get(
  "/:projectId",
  requireProjectAccess(ProjectRole.VIEWER),
  projectController.getProjectById,
);
router.put(
  "/:projectId",
  requireProjectAccess(ProjectRole.EDITOR),
  projectController.updateProject,
);
router.delete(
  "/:projectId",
  requireProjectAccess(ProjectRole.OWNER),
  projectController.deleteProject,
);

router.post(
  "/:projectId/members",
  requireProjectAccess(ProjectRole.OWNER),
  projectController.addMemberToProject,
);
router.delete(
  "/:projectId/members",
  requireProjectAccess(ProjectRole.OWNER),
  projectController.removeMemberFromProject,
);
router.put(
  "/:projectId/members",
  requireProjectAccess(ProjectRole.OWNER),
  projectController.updateMemberRole,
);

export { router as projectRouter };
