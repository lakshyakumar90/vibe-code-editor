import { authenticate } from "@repo/auth";
import { ProjectRole } from "@repo/db";
import { Router } from "express";
import { requireProjectAccess } from "../projects/project.middleware";
import { gitController } from "./git.controller";

/**
 * Phase 4A — Source Control routes, mounted at `/api/projects`
 * (paths carry their own `:projectId` so `requireProjectAccess` resolves).
 * Phase 4B adds remote sync, branches, history (no PRs/reviews/merges).
 *
 * Reads (status/diff/remote/branches/history): VIEWER.
 * Local mutations (ensure/stage/unstage/discard/commit): EDITOR.
 * Branch + remote mutations (create/checkout/fetch/pull/push): EDITOR
 * (push additionally requires live GitHub write permission).
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

// Phase 4B — remote state + synchronization (explicit origin only).
router.get(
  "/:projectId/git/remote",
  requireProjectAccess(ProjectRole.VIEWER),
  gitController.getRemote,
);
router.post(
  "/:projectId/git/fetch",
  requireProjectAccess(ProjectRole.VIEWER),
  gitController.fetch,
);
router.post(
  "/:projectId/git/pull",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.pull,
);
router.post(
  "/:projectId/git/push",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.push,
);

// Phase 4B — branches (create/switch locally; push is a separate action).
router.get(
  "/:projectId/git/branches",
  requireProjectAccess(ProjectRole.VIEWER),
  gitController.listBranches,
);
router.post(
  "/:projectId/git/branches",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.createBranch,
);
router.post(
  "/:projectId/git/checkout",
  requireProjectAccess(ProjectRole.EDITOR),
  gitController.checkout,
);

// Phase 4B — local history (reads from git, never Postgres).
router.get(
  "/:projectId/git/history",
  requireProjectAccess(ProjectRole.VIEWER),
  gitController.getHistory,
);
router.get(
  "/:projectId/git/history/:sha",
  requireProjectAccess(ProjectRole.VIEWER),
  gitController.getCommit,
);
router.get(
  "/:projectId/git/history/:sha/diff",
  requireProjectAccess(ProjectRole.VIEWER),
  gitController.getCommitDiff,
);

export { router as gitRouter };
