import type { PlanTask } from "@repo/ai";
import type { AiTransport, SendOptions, TransportEvents } from "./types";

/**
 * Local simulation transport (Phase 2 only). Exercises every UI state —
 * status line, token streaming, plan checklist progression, errors —
 * with zero backend. Deleted/replaced by the SSE transport in Phase 3;
 * the panel never changes because the interface is identical.
 */
export class MockTransport implements AiTransport {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private _aborted = false;

  get aborted(): boolean {
    return this._aborted;
  }

  abort(): void {
    this._aborted = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  send(opts: SendOptions, events: TransportEvents): void {
    this._aborted = false;
    this.timers = [];
    const later = (ms: number, fn: () => void) => {
      this.timers.push(setTimeout(() => {
        if (!this._aborted) fn();
      }, ms));
    };

    const attachNote =
      opts.attachments.length > 0
        ? ` with ${opts.attachments.length} file${opts.attachments.length === 1 ? "" : "s"} attached`
        : "";
    later(150, () => events.onStatus(`Context loaded${attachNote}`));

    if (opts.mode === "plan") {
      const tasks: PlanTask[] = [
        { title: "Understand the request and locate relevant files", status: "in_progress" },
        { title: "Draft the change checklist", status: "pending" },
        { title: "Validate against workspace (Phase 3)", status: "pending" },
      ];
      later(400, () => events.onPlan(tasks));
      later(1200, () =>
        events.onPlan([
          { title: tasks[0]!.title, status: "complete" },
          { title: tasks[1]!.title, status: "in_progress" },
          { title: tasks[2]!.title, status: "pending" },
        ]),
      );
      later(2000, () =>
        events.onPlan([
          { title: tasks[0]!.title, status: "complete" },
          { title: tasks[1]!.title, status: "complete" },
          { title: tasks[2]!.title, status: "in_progress" },
        ]),
      );
      later(2400, () => {
        events.onStatus("Plan ready — approval flow lands in Phase 3");
        events.onDone();
      });
      return;
    }

    const body =
      opts.mode === "agent"
        ? "Agent mode will run tools here in Phase 3. For now, here is a mock streamed reply to your prompt. "
        : "Mock streamed reply — the real provider response will stream here in Phase 3. ";
    const words = `${body}You asked: ${opts.prompt.slice(0, 80)}`.split(/(\s+)/);
    words.forEach((w, i) => {
      later(350 + i * 45, () => events.onToken(w));
    });
    later(350 + words.length * 45 + 150, () => {
      events.onStatus("Done (mock transport)");
      events.onDone();
    });
  }
}
