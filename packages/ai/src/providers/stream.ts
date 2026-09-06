import type { ChatMessage } from "../types.js";

/**
 * Shared streaming helpers. All byte handling here so providers stay thin.
 * Chunk boundaries are arbitrary — every splitter carries a buffer.
 */

/** Yield `data:` payloads from an SSE response body. Skips comments/blank lines. */
export async function* sseDataLines(res: Response): AsyncIterable<string> {
  const body = res.body;
  if (!body) throw new Error("Streaming response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line && !line.startsWith(":") && line.startsWith("data:")) {
        yield line.slice(5).trim();
      }
      idx = buf.indexOf("\n");
    }
  }
}

/** Yield text content from newline-delimited JSON (Ollama-style NDJSON). */
export async function* ndjsonLines(res: Response): AsyncIterable<unknown> {
  const body = res.body;
  if (!body) throw new Error("Streaming response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        try {
          yield JSON.parse(line) as unknown;
        } catch {
          // Partial line at a chunk edge stays buffered; truly malformed
          // lines are skipped rather than killing the stream.
        }
      }
      idx = buf.indexOf("\n");
    }
  }
  const tail = buf.trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as unknown;
    } catch {
      // ignore trailing fragment
    }
  }
}

export function toOpenAIMessages(messages: ChatMessage[]): Array<{
  role: string;
  content: string;
}> {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
