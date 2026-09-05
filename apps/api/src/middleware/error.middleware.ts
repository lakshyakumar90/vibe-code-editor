import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { Prisma } from "@repo/db";

// Transient connection/pool errors (Neon pooler cold starts, timeouts).
// Safe to retry — never leak internals to the client.
const RETRYABLE_DB_CODES = new Set(["P1001", "P1002", "P1017", "P2024", "P2028"]);

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err);

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      code: "VALIDATION_ERROR",
      message: "Invalid request data",
      errors: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    RETRYABLE_DB_CODES.has(err.code)
  ) {
    return res.status(503).json({
      success: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Database temporarily unavailable, please try again",
    });
  }

  return res.status(500).json({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: "Something went wrong",
  });
}
