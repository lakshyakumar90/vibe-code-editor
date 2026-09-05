"use client";

import { useRuntime } from "./runtime-provider";

/**
 * Step 1 — read-only preview + log tail (V1).
 * Full xterm terminal is a V2 milestone; install/dev output goes here.
 */
export function PreviewPanel() {
  const { status, previewUrl, logs, error } = useRuntime();

  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l bg-card">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Preview</span>
        <span data-testid="runtime-status">{status}</span>
      </div>

      <div className="min-h-0 flex-1 bg-background">
        {previewUrl ? (
          <iframe
            title="preview"
            src={previewUrl}
            className="h-full w-full border-0"
            allow="cross-origin-isolated"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
            {status === "error"
              ? (error ?? "Runtime failed to start.")
              : "Booting WebContainer… preview appears here."}
          </div>
        )}
      </div>

      <div className="flex h-40 shrink-0 flex-col border-t">
        <div className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Output
        </div>
        <pre className="min-h-0 flex-1 overflow-y-auto p-3 text-[11px] leading-relaxed">
          {logs.length === 0 ? "No output yet." : logs.join("")}
        </pre>
      </div>
    </aside>
  );
}
