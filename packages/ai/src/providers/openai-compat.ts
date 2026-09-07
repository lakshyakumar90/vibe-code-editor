import type { AiProvider, ChatRequest, InlineRequest } from "../types";
import { INLINE_FENCE_INSTRUCTION } from "../inline";
import { sseDataLines, toOpenAIMessages } from "./stream";

/** Shared OpenAI-compatible chat-completions client (OpenAI + Groq). */

export interface OpenAICompatConfig {
  baseURL: string;
  apiKey: string;
  defaultModel: string;
}

interface ChatDelta {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

export async function* streamChatCompletions(
  cfg: OpenAICompatConfig,
  model: string,
  messages: ChatRequest["messages"],
  temperature: number | undefined,
  signal: AbortSignal | undefined,
): AsyncIterable<string> {
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(messages),
      stream: true,
      ...(temperature !== undefined ? { temperature } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat completions failed (${res.status}): ${text.slice(0, 300)}`);
  }
  for await (const payload of sseDataLines(res)) {
    if (payload === "[DONE]") return;
    let json: ChatDelta;
    try {
      json = JSON.parse(payload) as ChatDelta;
    } catch {
      continue;
    }
    const token = json.choices?.[0]?.delta?.content;
    if (typeof token === "string" && token.length > 0) yield token;
  }
}

export async function completeChatCompletions(
  cfg: OpenAICompatConfig,
  model: string,
  messages: ChatRequest["messages"],
  temperature: number | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(messages),
      stream: false,
      ...(temperature !== undefined ? { temperature } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat completion failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return json.choices?.[0]?.message?.content ?? "";
}

function resolveModel(reqModel: string | undefined, cfg: OpenAICompatConfig): string {
  return reqModel || process.env["AI_DEFAULT_MODEL"] || cfg.defaultModel;
}

/** Base class for OpenAI-API-compatible providers. */
export abstract class OpenAICompatProvider implements AiProvider {
  abstract readonly id: AiProvider["id"];
  abstract readonly name: string;
  protected abstract config(): OpenAICompatConfig;
  abstract isConfigured(): boolean;

  defaultModel(): string {
    return this.config().defaultModel;
  }

  async *streamChat(req: ChatRequest): AsyncIterable<string> {
    const cfg = this.config();
    yield* streamChatCompletions(
      cfg,
      resolveModel(req.model, cfg),
      req.messages,
      req.temperature,
      req.signal,
    );
  }

  async completeInline(req: InlineRequest): Promise<string> {
    const cfg = this.config();
    return completeChatCompletions(
      cfg,
      resolveModel(req.model, cfg),
      [
        {
          role: "system",
          content: INLINE_FENCE_INSTRUCTION,
        },
        {
          role: "user",
          content: `<prefix>\n${req.prefix}\n</prefix>\n<suffix>\n${req.suffix ?? ""}\n</suffix>`,
        },
      ],
      req.temperature ?? 0.2,
      req.signal,
    );
  }
}
