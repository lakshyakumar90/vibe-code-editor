import "express";
import type { ProjectMember } from "@repo/db/generated/prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: any,
      session?: any,
      projectMember?: ProjectMember
    }
  }
}