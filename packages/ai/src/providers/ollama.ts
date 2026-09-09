import type { AiProvider, ChatRequest, InlineRequest } from "../types";
import { INLINE_FENCE_INSTRUCTION } from "../inline";
import { ndjsonLines } from "./stream";

/**
 * Tight output cap for local inline: ghost text is 1-5 lines. 800 tokens
 * (cloud-sized) keeps a local model generating for 5s+ until Monaco cancels
 * the request — observed as `(canceled)` in the network tab. 128 tokens
 * returns in ~1s and still fills the fence.
 */
const OLLAMA_INLINE_NUM_PREDICT = 128;

/** Local Ollama (NDJSON streaming via /api/chat). */

function baseURL(): string {
  return process.env["OLLAMA_URL"] || "http://localhost:11434";
}

function resolveModel(reqModel: string | undefined): string {
  return reqModel || process.env["AI_DEFAULT_MODEL"] || process.env["OLLAMA_MODEL"] || "gemma4:e2b";
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
        // Agent/plan turns carry whole files + long changesets — the 4k
        // default context truncates mid-JSON (unclosed-fence). No output cap:
        // truncating here is what strands the changeset fence.
        options: {
          num_ctx: 8192,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        },
        keep_alive: "30m",
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
    const model = resolveModel(req.model);
    if (process.env["NODE_ENV"] !== "production") {
      console.debug(`[ollama] completeInline model=${model}`);
    }
    const res = await fetch(`${baseURL()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: INLINE_FENCE_INSTRUCTION,
          },
          {
            role: "user",
            content: `<prefix>\n${req.prefix}\n</prefix>\n<suffix>\n${req.suffix ?? ""}\n</suffix>`,
          },
        ],
        stream: false,
        // Inline-only caps: ghost text needs little output. An uncapped
        // local model rambles past the API 15s abort and gets cleaned to "".
        // `think: false` skips chain-of-thought on reasoning models (ignored
        // otherwise) — both cut time-to-first-byte for ghost text.
        think: false,
        options: {
          temperature: req.temperature ?? 0.2,
          num_predict: OLLAMA_INLINE_NUM_PREDICT,
          num_ctx: 4096,
        },
        keep_alive: "30m",
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
