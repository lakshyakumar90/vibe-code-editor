"use client";

import { useState } from "react";
import { useRuntime } from "./runtime-provider";
import { TerminalPanel } from "./terminal-panel";

type SidebarTab = "preview" | "terminal";

/**
 * Right sidebar: dev-server preview + interactive xterm shell.
 * Install/dev process output streams into Output below both tabs.
 */
export function PreviewPanel() {
  const { status, previewUrl, logs, error } = useRuntime();
  const [tab, setTab] = useState<SidebarTab>("preview");

  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l bg-card">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab("preview")}
            className={`rounded px-2 py-1 ${tab === "preview" ? "bg-accent text-foreground" : "hover:text-foreground"}`}
          >
            Preview
          </button>
          <button
            onClick={() => setTab("terminal")}
            className={`rounded px-2 py-1 ${tab === "terminal" ? "bg-accent text-foreground" : "hover:text-foreground"}`}
          >
            Terminal
          </button>
        </div>
        <span data-testid="runtime-status">{status}</span>
      </div>

      <div className="min-h-0 flex-1 bg-background">
        {/* Kept mounted so the shell survives tab switches; the
            ResizeObserver in TerminalPanel re-fits on reveal. */}
        <div className={`h-full w-full ${tab === "terminal" ? "" : "hidden"}`}>
          <TerminalPanel />
        </div>
        {tab === "preview" &&
          (previewUrl ? (
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
          ))}
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
