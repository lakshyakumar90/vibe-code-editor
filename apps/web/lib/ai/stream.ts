import { parseSSEBlock } from "@repo/ai";
import type { TransportEvents } from "./types";

/**
 * SSE reader for POST /api/ai/generate (wired in Phase 3).
 * Consumes `event: <type>` / `data: <json>` blocks and dispatches to
 * TransportEvents. Pure fetch — no EventSource (we POST a body).
 */
export async function readSSEStream(
  res: Response,
  events: TransportEvents,
  signal?: AbortSignal,
): Promise<void> {
  if (!res.ok || !res.body) {
    throw new Error(`AI stream failed (http ${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let eventType = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (!eventType && dataLines.length === 0) return;
    const parsed = parseSSEBlock(eventType || "token", dataLines.join("\n"));
    eventType = "";
    dataLines = [];
    if (!parsed) return;
    switch (parsed.type) {
      case "token": {
        const t = (parsed.data as { token?: unknown }).token;
        if (typeof t === "string" && t.length > 0) events.onToken(t);
        break;
      }
      case "status": {
        const s = (parsed.data as { message?: unknown; status?: unknown }).message ??
          (parsed.data as { status?: unknown }).status;
        if (typeof s === "string") events.onStatus(s);
        break;
      }
      case "plan": {
        const p = (parsed.data as { plan?: unknown }).plan ??
          (parsed.data as { steps?: unknown }).steps ??
          parsed.data;
        if (Array.isArray(p)) {
          events.onPlan(
            p.map((t) => ({
              title: String((t as { title?: unknown }).title ?? "Untitled step"),
              status:
                (t as { status?: string }).status === "complete" ||
                (t as { status?: string }).status === "in_progress"
                  ? ((t as { status?: string }).status as "complete" | "in_progress")
                  : ("pending" as const),
            })),
          );
        }
        break;
      }
      case "error": {
        const m = (parsed.data as { message?: unknown }).message;
        events.onError(typeof m === "string" ? m : "AI request failed");
        break;
      }
      case "done":
        events.onDone();
        break;
    }
  };

  for (;;) {
    if (signal?.aborted) return;
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line === "") {
        dispatch();
      } else if (line.startsWith(":")) {
        // keep-alive comment — ignore
      } else if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
      idx = buf.indexOf("\n");
    }
  }
  dispatch();
}

const API_URL =
  process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:5000";

/** POST helper used by the Phase 3 transport (kept here for reuse). */
export async function postGenerate(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${API_URL}/api/ai/generate`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
