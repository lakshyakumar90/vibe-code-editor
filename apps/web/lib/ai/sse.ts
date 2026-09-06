import { postGenerate, readSSEStream } from "./stream";
import type { AiTransport, SendOptions, TransportEvents } from "./types";

/**
 * Live SSE transport hitting POST /api/ai/generate (Phase 3).
 * Same interface as the retired mock — the panel never changes.
 */
export class SseTransport implements AiTransport {
  private controller: AbortController | null = null;
  private _aborted = false;

  get aborted(): boolean {
    return this._aborted;
  }

  abort(): void {
    this._aborted = true;
    try {
      this.controller?.abort();
    } catch {
      // already settled
    }
    this.controller = null;
  }

  send(opts: SendOptions, events: TransportEvents): void {
    this._aborted = false;
    const controller = new AbortController();
    this.controller = controller;

    void (async () => {
      try {
        const res = await postGenerate(
          {
            projectId: opts.projectId,
            mode: opts.mode,
            prompt: opts.prompt,
            attachments: opts.attachments,
            history: opts.history,
          },
          controller.signal,
        );
        await readSSEStream(res, events, controller.signal);
      } catch (err) {
        if (controller.signal.aborted || this._aborted) return;
        events.onError(
          err instanceof Error ? err.message : "AI request failed",
        );
      }
    })();
  }
}
