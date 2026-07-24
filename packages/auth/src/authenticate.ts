import "./types";
import { auth } from "./auth";
import type { Request, Response, NextFunction } from "express";

export async function authenticate(
  req: Request,
  res: Response, 
  next: NextFunction
) {
  try {
    const session = await auth.api.getSession({
      headers: req.headers as HeadersInit
    });
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