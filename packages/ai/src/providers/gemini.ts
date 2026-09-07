import type { AiProvider, ChatRequest, InlineRequest } from "../types";
import { INLINE_FENCE_INSTRUCTION } from "../inline";
import { sseDataLines } from "./stream";

/** Google Gemini via the Generative Language REST API (SSE streaming). */

interface GeminiPart {
  text?: string;
}
interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}
interface GeminiStreamEvent {
  candidates?: Array<{ content?: GeminiContent }>;
  promptFeedback?: unknown;
}

function apiKey(): string {
  return (
    process.env["GEMINI_API_KEY"] ||
    process.env["GOOGLE_API_KEY"] ||
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ||
    ""
  );
}

function resolveModel(reqModel: string | undefined): string {
  return reqModel || process.env["AI_DEFAULT_MODEL"] || "gemini-2.5-flash";
}

function toContents(messages: ChatRequest["messages"]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
} {
  const contents: GeminiContent[] = [];
  let system: string | null = null;
  for (const m of messages) {
    if (m.role === "system") {
      system = system === null ? m.content : `${system}\n${m.content}`;
      continue;
    }
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }
  return {
    ...(system !== null ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
  };
}

function partsText(content: GeminiContent | undefined): string {
  if (!content?.parts) return "";
  return content.parts.map((p) => p.text ?? "").join("");
}

export class GeminiProvider implements AiProvider {
  readonly id = "gemini" as const;
  readonly name = "Gemini";

  isConfigured(): boolean {
    return apiKey().length > 0;
  }

  defaultModel(): string {
    return "gemini-2.5-flash";
  }

  async *streamChat(req: ChatRequest): AsyncIterable<string> {
    const model = resolveModel(req.model);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey(),
        },
        body: JSON.stringify({
          ...toContents(req.messages),
          ...(req.temperature !== undefined
            ? { generationConfig: { temperature: req.temperature } }
            : {}),
        }),
        signal: req.signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini stream failed (${res.status}): ${text.slice(0, 300)}`);
    }
    // Gemini may repeat cumulative text across events — emit only the
    // unseen suffix so callers always get true deltas.
    let emitted = "";
    for await (const payload of sseDataLines(res)) {
      let json: GeminiStreamEvent;
      try {
        json = JSON.parse(payload) as GeminiStreamEvent;
      } catch {
        continue;
      }
      const full = partsText(json.candidates?.[0]?.content);
      if (!full) continue;
      if (full.startsWith(emitted)) {
        const delta = full.slice(emitted.length);
        emitted = full;
        if (delta) yield delta;
      } else {
        emitted = full;
        yield full;
      }
    }
  }

  async completeInline(req: InlineRequest): Promise<string> {
    const model = resolveModel(req.model);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey(),
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: INLINE_FENCE_INSTRUCTION,
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `<prefix>\n${req.prefix}\n</prefix>\n<suffix>\n${req.suffix ?? ""}\n</suffix>`,
                },
              ],
            },
          ],
          generationConfig: { temperature: req.temperature ?? 0.2 },
        }),
        signal: req.signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini completion failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: GeminiContent }>;
    };
    return partsText(json.candidates?.[0]?.content);
  }
}
