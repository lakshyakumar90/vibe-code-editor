import type { Request, Response } from "express";

/**
 * Phase 0 stubs — every handler returns 501 NOT_IMPLEMENTED.
 * Real logic lands in Phase 1 (providers) and Phase 3 (orchestrator,
 * modes, changesets). Route map + role gates are final.
 */
function notImplemented(res: Response, what: string) {
  return res.status(501).json({
    success: false,
    code: "NOT_IMPLEMENTED",
    message: `AI ${what} is not implemented yet (Phase 0 stub)`,
  });
}

export const aiController = {
  async getStatus(_req: Request, res: Response) {
    return notImplemented(res, "provider status");
  },

  async listProviders(_req: Request, res: Response) {
    return notImplemented(res, "provider listing");
  },

  async listConversations(_req: Request, res: Response) {
    return notImplemented(res, "conversation listing");
  },

  async getConversation(_req: Request, res: Response) {
    return notImplemented(res, "conversation fetch");
  },

  async getMessages(_req: Request, res: Response) {
    return notImplemented(res, "message listing");
  },

  async complete(_req: Request, res: Response) {
    return notImplemented(res, "inline completion");
  },

  async generate(_req: Request, res: Response) {
    return notImplemented(res, "generation");
  },

  async getChangeSet(_req: Request, res: Response) {
    return notImplemented(res, "changeset fetch");
  },

  async applyChangeSet(_req: Request, res: Response) {
    return notImplemented(res, "changeset apply");
  },

  async rejectChangeSet(_req: Request, res: Response) {
    return notImplemented(res, "changeset reject");
  },
};
