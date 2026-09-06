import type { AiProvider, AiProviderId } from "./types.js";
import { OpenAIProvider } from "./providers/openai.js";
import { GroqProvider } from "./providers/groq.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OllamaProvider } from "./providers/ollama.js";
import { MockProvider } from "./providers/mock.js";

export interface ProviderMeta {
  id: AiProviderId;
  label: string;
  /** Env var holding the key (`null` when keyless). */
  envKey: string | null;
  defaultModel: string;
}

/** Registry metadata for the status/providers endpoints (Phase 1). */
export const SUPPORTED_PROVIDERS: Record<AiProviderId, ProviderMeta> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
  },
  groq: {
    id: "groq",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    defaultModel: "openai/gpt-oss-20b",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    envKey: null,
    defaultModel: "gemma3:latest",
  },
  mock: {
    id: "mock",
    label: "Mock",
    envKey: null,
    defaultModel: "mock-1",
  },
};

function normalizeId(id: string | undefined): AiProviderId {
  const norm = (id ?? process.env["AI_PROVIDER"] ?? "openai").toLowerCase();
  if (norm === "google") return "gemini";
  if ((Object.keys(SUPPORTED_PROVIDERS) as string[]).includes(norm)) {
    return norm as AiProviderId;
  }
  throw new Error(
    `Unknown AI provider "${id}". Supported: ${Object.keys(SUPPORTED_PROVIDERS).join(", ")}`,
  );
}

/**
 * Env-driven factory with per-request override. Env is read lazily so
 * import order vs dotenv never matters.
 *
 * Unknown ids throw. Known-but-unconfigured providers are returned
 * as-is — callers check `isConfigured()` and decide (fall back to mock
 * or fail). The default (no id) never throws.
 */
export function createProvider(id?: string): AiProvider {
  switch (normalizeId(id)) {
    case "openai":
      return new OpenAIProvider();
    case "groq":
      return new GroqProvider();
    case "gemini":
      return new GeminiProvider();
    case "ollama":
      return new OllamaProvider();
    case "mock":
      return new MockProvider();
  }
}
