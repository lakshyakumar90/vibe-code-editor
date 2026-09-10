import "./types";
import type { Request, Response, NextFunction } from "express";
import { resolveSessionFromHeaders } from "./session";

export async function authenticate(
  req: Request,
  res: Response, 
  next: NextFunction
) {
  try {
    const session = await resolveSessionFromHeaders(
      req.headers as Record<string, string | string[] | undefined>,
    );
    if (!session) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    req.user = session.user;
    req.session = session.session;
    next();
  } catch (error) {
    return res.status(500).json({ message: "Internal Server Error" });
  }
}