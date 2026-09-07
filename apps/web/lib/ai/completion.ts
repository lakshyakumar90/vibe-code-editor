const API_URL =
  process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:5000";

export interface CompletionRequest {
  projectId: string;
  filePath?: string;
  language?: string;
  cursor: { line: number; column: number; offset: number };
  prefix: string;
  suffix?: string;
  signal?: AbortSignal;
  /** Phase E: per-request inline provider/model (server falls back when omitted). */
  provider?: string;
  model?: string;
}

/**
 * Single ghost-text completion via POST /api/ai/complete.
 * Returns "" on abort/empty; throws on real failures (caller swallows).
 */
export async function fetchCompletion(req: CompletionRequest): Promise<string> {
  const res = await fetch(`${API_URL}/api/ai/complete`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: req.projectId,
      filePath: req.filePath,
      language: req.language,
      cursor: req.cursor,
      prefix: req.prefix,
      suffix: req.suffix ?? "",
      ...(req.provider ? { provider: req.provider } : {}),
      ...(req.model ? { model: req.model } : {}),
    }),
    signal: req.signal,
  });
  if (!res.ok) {
    throw new Error(`Completion failed (http ${res.status})`);
  }
  const json = (await res.json()) as {
    success?: boolean;
    data?: { completion?: unknown };
  };
  const text = json.data?.completion;
  return typeof text === "string" ? text.replace(/\r/g, "") : "";
}
