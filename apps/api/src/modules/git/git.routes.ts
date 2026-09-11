import { authenticate } from "@repo/auth";
import { ProjectRole } from "@repo/db";
import { Router } from "express";
import { requireProjectAccess } from "../projects/project.middleware";
import { gitController } from "./git.controller";

/**
 * Phase 4A — Source Control routes, mounted at `/api/projects`
 * (paths carry their own `:projectId` so `requireProjectAccess` resolves).
 *
 * Reads: VIEWER. Mutations (ensure/stage/unstage/discard/commit): EDITOR.
 * No remote operations exist in 4A — no push/pull/fetch/branch routes.
 */
const router = Router();

router.use(authenticate);

router.post(
  "/:projectId/git/ensure",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.ensure,
);
router.get(
  "/:projectId/git/status",
  requireProjectAccess(ProjectRole.VIEWER),
  gitController.getStatus,
);
router.get(
  "/:projectId/git/diff",
  requireProjectAccess(ProjectRole.VIEWER),
  gitController.getDiff,
);
router.post(
  "/:projectId/git/stage",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.stage,
);
router.post(
  "/:projectId/git/unstage",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.unstage,
);
router.post(
  "/:projectId/git/stage-all",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.stageAll,
);
router.post(
  "/:projectId/git/unstage-all",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.unstageAll,
);
router.post(
  "/:projectId/git/discard",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.discard,
);
router.post(
  "/:projectId/git/commit",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.commit,
);

export { router as gitRouter };
