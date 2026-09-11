import { authenticate } from "@repo/auth";
import { Router } from "express";
import { githubController } from "./github.controller";

const router = Router();

router.use(authenticate);

router.get("/status", githubController.getStatus);
router.post("/connect", githubController.connect);
router.post("/disconnect", githubController.disconnect);

export { router as githubRouter };
