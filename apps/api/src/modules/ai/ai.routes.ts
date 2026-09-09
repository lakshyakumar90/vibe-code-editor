import { authenticate } from "@repo/auth";
import { ProjectRole } from "@repo/db";
import { Router } from "express";
import { requireAIProjectAccess } from "./ai.middleware";
import { aiController } from "./ai.controller";

const router = Router();

// All AI routes require authentication.
router.use(authenticate);

// Provider status — Phase 1 implements (501 until then).
router.get("/status", aiController.getStatus);
router.get("/providers", aiController.listProviders);

// DB-authoritative conversation APIs (Phase 3).
router.get("/conversations", aiController.listConversations);
router.get("/conversations/:id", aiController.getConversation);
router.get(
  "/conversations/:id/messages",
  aiController.getMessages,
);

// Inline completion: POST /api/ai/complete — JSON (not SSE).
router.post(
  "/complete",
  requireAIProjectAccess(ProjectRole.VIEWER),
  aiController.complete,
);

// Common orchestrator entry: POST /api/ai/generate (mode in body).
// NOTE: agent mode requires EDITOR — enforced in the Phase 3 controller
// via a MODE_MIN_ROLE check (mode is only known after body validation,
// so the route-level gate stays at VIEWER).
router.post(
  "/generate",
  requireAIProjectAccess(ProjectRole.VIEWER),
  aiController.generate,
);

// Terminal rendezvous for agent runCommand (projectId in body).
// EDITOR: running commands mutates the project like file edits do.
router.post(
  "/command-result",
  requireAIProjectAccess(ProjectRole.EDITOR),
  aiController.commandResult,
);

// ChangeSet review gate (Phase 3+): fetch diffs, apply, reject.
// Project-scoped via the changeset's projectId; membership is checked
// in the controller (no projectId in these URLs).
router.get("/changeset/:id", aiController.getChangeSet);
router.post("/changeset/:id/apply", aiController.applyChangeSet);
router.post("/changeset/:id/reject", aiController.rejectChangeSet);

export { router as aiRouter };
