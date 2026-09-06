import type { AiProvider, ChatRequest, InlineRequest } from "../types";
import { sleep } from "./stream";

/** Deterministic mock for dev/test without keys or Ollama. Always configured. */

const TOKENS = ["Mock ", "streaming ", "response ", "— ", "no ", "keys ", "needed."];

export class MockProvider implements AiProvider {
  readonly id = "mock" as const;
  readonly name = "Mock";

  isConfigured(): boolean {
    return true;
  }

  defaultModel(): string {
    return "mock-1";
  }

  async *streamChat(req: ChatRequest): AsyncIterable<string> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const echo = lastUser ? ` (echo: ${lastUser.content.slice(0, 40)})` : "";
    for (const t of TOKENS) {
      await sleep(120);
      yield t;
    }
    yield echo;
  }

  async completeInline(_req: InlineRequest): Promise<string> {
    await sleep(150);
    return "// mock completion";
  }
}
