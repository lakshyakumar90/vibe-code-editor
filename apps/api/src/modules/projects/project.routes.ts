import { authenticate } from "@repo/auth";
import { ProjectRole } from "@repo/db";
import { Router } from "express";
import { requireProjectAccess } from "./project.middleware";
import { projectController } from "./project.controller";
import { fileController } from "./files/file.controller";

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

// File routes

router.get(
  "/:projectId/files",
  requireProjectAccess(ProjectRole.VIEWER),
  fileController.listFiles,
);
router.get(
  "/:projectId/files/file",
  requireProjectAccess(ProjectRole.VIEWER),
  fileController.getFile,
);
router.post(
  "/:projectId/files",
  requireProjectAccess(ProjectRole.EDITOR),
  fileController.createFile,
);
router.put(
  "/:projectId/files/:fileId",
  requireProjectAccess(ProjectRole.EDITOR),
  fileController.updateFile,
);
router.delete(
  "/:projectId/files/:fileId",
  requireProjectAccess(ProjectRole.EDITOR),
  fileController.deleteFile,
);  
router.put(
  "/:projectId/files/:fileId/move",
  requireProjectAccess(ProjectRole.EDITOR),
  fileController.moveFile,
);
  
export { router as projectRouter };
