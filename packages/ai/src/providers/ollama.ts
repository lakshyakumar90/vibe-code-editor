import type { AiProvider, ChatRequest, InlineRequest } from "../types";
import { ndjsonLines } from "./stream";

/** Local Ollama (NDJSON streaming via /api/chat). */

function baseURL(): string {
  return process.env["OLLAMA_URL"] || "http://localhost:11434";
}

function resolveModel(reqModel: string | undefined): string {
  return reqModel || process.env["OLLAMA_MODEL"] || "gemma4:e2b";
}

interface OllamaChatLine {
  message?: { role?: string; content?: string };
  done?: boolean;
  error?: string;
}

export class OllamaProvider implements AiProvider {
  readonly id = "ollama" as const;
  readonly name = "Ollama (local)";

  /** Reachability is checked lazily at call time, not here. */
  isConfigured(): boolean {
    return true;
  }

  defaultModel(): string {
    return "gemma4:e2b";
  }

  async *streamChat(req: ChatRequest): AsyncIterable<string> {
    const res = await fetch(`${baseURL()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolveModel(req.model),
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        ...(req.temperature !== undefined
          ? { options: { temperature: req.temperature } }
          : {}),
      }),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama chat failed (${res.status}): ${text.slice(0, 300)}`);
    }
    for await (const line of ndjsonLines(res)) {
      const msg = line as OllamaChatLine;
      if (msg.error) throw new Error(`Ollama error: ${msg.error}`);
      const token = msg.message?.content;
      if (typeof token === "string" && token.length > 0) yield token;
      if (msg.done) return;
    }
  }

  async completeInline(req: InlineRequest): Promise<string> {
    const res = await fetch(`${baseURL()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolveModel(req.model),
        messages: [
          {
            role: "system",
            content:
              "You are a code completion engine. Return only the code that continues the snippet — no explanations, no fences.",
          },
          {
            role: "user",
            content: `<prefix>\n${req.prefix}\n</prefix>\n<suffix>\n${req.suffix ?? ""}\n</suffix>`,
          },
        ],
        stream: false,
        options: { temperature: req.temperature ?? 0.2 },
      }),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama completion failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as OllamaChatLine;
    if (json.error) throw new Error(`Ollama error: ${json.error}`);
    return json.message?.content ?? "";
  }
}
