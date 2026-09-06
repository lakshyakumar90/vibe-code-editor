"use client";

import { useCallback, useState } from "react";
import { Maximize, Minimize, Play, RotateCcw, RotateCw } from "lucide-react";
import { useRuntime } from "./runtime-provider";

const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 800;

/**
 * Right sidebar: dev-server preview only.
 * Terminals live in the bottom panel (one tab per shell).
 */
export function PreviewPanel({
  fullscreen = false,
  onToggleFullscreen,
}: {
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const { status, previewUrl, error, reset, restartDev } = useRuntime();
  const [restarting, setRestarting] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const diff = moveEvent.clientX - startX;
        setSidebarWidth(
          Math.min(
            Math.max(startWidth - diff, MIN_SIDEBAR_WIDTH),
            MAX_SIDEBAR_WIDTH,
          ),
        );
      };
      const handleMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [sidebarWidth],
  );

  const previewHost = (() => {
    if (!previewUrl) return null;
    try {
      return new URL(previewUrl).host;
    } catch {
      return previewUrl;
    }
  })();

  return (
    <div className={`flex h-full overflow-hidden ${fullscreen ? "min-w-0 flex-1" : "shrink-0"}`}>
      {!fullscreen && (
        <div
          onMouseDown={handleResizeStart}
          className={`w-1 shrink-0 cursor-col-resize transition-colors hover:bg-primary/20 ${isResizing ? "bg-primary/20" : ""}`}
        />
      )}
      <aside
        style={fullscreen ? undefined : { width: sidebarWidth }}
        className={`flex h-full flex-col overflow-hidden border-l bg-card ${fullscreen ? "w-full border-l-0" : ""}`}
      >
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Preview</span>
        <span className="flex items-center gap-1.5" data-testid="runtime-status">
          <span
            className={`size-2 rounded-full ${
              status === "ready"
                ? "bg-green-500"
                : status === "error"
                  ? "bg-red-500"
                  : status === "stopped"
                    ? "bg-muted-foreground/40"
                    : "bg-yellow-500 animate-pulse"
            }`}
          />
          {status}
        </span>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/40 px-2 text-xs">
          <span
            className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-muted-foreground"
            title={previewUrl ?? "No preview URL yet"}
          >
            {previewHost ?? "Waiting for dev server…"}
          </span>
          <button
            onClick={() => setFrameKey((k) => k + 1)}
            disabled={!previewUrl}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            title="Reload preview"
          >
            <RotateCw className="size-3.5" />
          </button>
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={fullscreen ? "Exit full preview" : "Full preview"}
            >
              {fullscreen ? (
                <Minimize className="size-3.5" />
              ) : (
                <Maximize className="size-3.5" />
              )}
            </button>
          )}
      </div>

      <div className="min-h-0 flex-1 bg-white">
        {previewUrl ? (
            <div className="h-full w-full bg-white" style={{ colorScheme: "light" }}>
              <iframe
                key={frameKey}
                title="preview"
                src={previewUrl}
                className="h-full w-full border-0 bg-white"
                allow="cross-origin-isolated"
              />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
              {status === "error" ? (
                <>
                  <span className="font-medium text-foreground">
                    Runtime failed to start
                  </span>
                  <span className="max-w-full break-words text-xs">
                    {error ?? "Unknown error."}
                  </span>
                  <span className="text-xs">
                    Check the terminal in the bottom panel for details.
                  </span>
                  <button
                    onClick={reset}
                    className="mt-1 flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
                  >
                    <RotateCcw className="size-3.5" />
                    Retry boot
                  </button>
                </>
              ) : status === "stopped" ? (
                <>
                  <span className="font-medium text-foreground">
                    Dev server stopped
                  </span>
                  <span className="text-xs">
                    The dev server was stopped (Ctrl+C) or crashed.
                  </span>
                  <button
                    onClick={() => {
                      setRestarting(true);
                      void restartDev().finally(() => setRestarting(false));
                    }}
                    disabled={restarting}
                    className="mt-1 flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    <Play className="size-3.5" />
                    {restarting ? "Restarting…" : "Restart dev server"}
                  </button>
                </>
              ) : (
                <>
                  <span className="font-medium text-foreground">
                    Starting dev server…
                  </span>
                  <span className="text-xs">
                    Installing dependencies, then the preview appears here.
                  </span>
                </>
              )}
            </div>
          )}
      </div>
      </aside>
    </div>
  );
}
