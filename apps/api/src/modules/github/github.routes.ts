import { authenticate } from "@repo/auth";
import { Router } from "express";
import { githubController } from "./github.controller";
import { importController } from "./import.controller";
import { reposController } from "./repos.controller";

const router = Router();

router.use(authenticate);

router.get("/status", githubController.getStatus);
router.post("/connect", githubController.connect);
router.post("/disconnect", githubController.disconnect);

// Phase 2 — repository discovery (explicit endpoints only; no proxy).
router.get("/repos", reposController.listRepos);
router.get("/repos/:owner/:repo", reposController.getRepo);
router.get("/repos/:owner/:repo/inspection", reposController.getInspection);

// Phase 3 — repository import (server-verified; no Git execution).
router.post("/import", importController.importRepo);

export { router as githubRouter };
