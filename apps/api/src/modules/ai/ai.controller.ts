import type { Request, Response } from "express";
import { createProvider, SUPPORTED_PROVIDERS } from "@repo/ai";
import type { AiProviderId } from "@repo/ai";

/**
 * Phase 1: provider status endpoints are live. Orchestrator, modes,
 * and changesets remain 501 stubs until Phase 3.
 */
function notImplemented(res: Response, what: string) {
  return res.status(501).json({
    success: false,
    code: "NOT_IMPLEMENTED",
    message: `AI ${what} is not implemented yet`,
  });
}

function hasKeyFor(id: AiProviderId): boolean {
  switch (id) {
    case "openai":
      return !!process.env["OPENAI_API_KEY"];
    case "groq":
      return !!process.env["GROQ_API_KEY"];
    case "gemini":
      return !!(
        process.env["GEMINI_API_KEY"] ||
        process.env["GOOGLE_API_KEY"] ||
        process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
      );
    case "ollama":
    case "mock":
      return true;
  }
}

export const aiController = {
  async getStatus(_req: Request, res: Response) {
    const provider = createProvider();
    return res.json({
      success: true,
      data: {
        provider: provider.id,
        name: provider.name,
        configured: provider.isConfigured(),
        defaultModel: process.env["AI_DEFAULT_MODEL"] || provider.defaultModel(),
        env: {
          AI_PROVIDER: process.env["AI_PROVIDER"] ?? "openai (default)",
          AI_DEFAULT_MODEL: process.env["AI_DEFAULT_MODEL"] ?? "(provider default)",
          has_OPENAI: !!process.env["OPENAI_API_KEY"],
          has_GROQ: !!process.env["GROQ_API_KEY"],
          has_GEMINI: hasKeyFor("gemini"),
          OLLAMA_URL: process.env["OLLAMA_URL"] ?? "http://localhost:11434",
          OLLAMA_MODEL: process.env["OLLAMA_MODEL"] ?? "gemma3:latest",
        },
      },
    });
  },

  async listProviders(_req: Request, res: Response) {
    const def = (process.env["AI_PROVIDER"] ?? "openai").toLowerCase();
    const providers = (Object.keys(SUPPORTED_PROVIDERS) as AiProviderId[]).map(
      (id) => {
        const meta = SUPPORTED_PROVIDERS[id];
        let configured = false;
        try {
          const p = createProvider(id);
          // mock is always configured; ollama reachability is checked
          // lazily at call time, so report configured here.
          configured = p.isConfigured();
          if (p.id === "mock" && id !== "mock") configured = false;
        } catch {
          configured = false;
        }
        const hasKey = hasKeyFor(id);
        return {
          ...meta,
          hasKey,
          configured: hasKey && configured,
          isDefault: def === id || (def === "google" && id === "gemini"),
        };
      },
    );
    return res.json({ success: true, data: providers });
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
