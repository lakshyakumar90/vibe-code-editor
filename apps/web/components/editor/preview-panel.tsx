"use client";

import { useCallback, useState } from "react";
import { ExternalLink, Monitor, Moon, RotateCcw, RotateCw, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useRuntime } from "./runtime-provider";
import { TerminalPanel } from "./terminal-panel";

type SidebarTab = "preview" | "terminal";
type PreviewAppearance = "system" | "light" | "dark";

const APPEARANCE_ORDER: PreviewAppearance[] = ["system", "light", "dark"];

const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 800;

/**
 * Right sidebar: dev-server preview + persistent xterm terminal.
 * Install/dev process output is mirrored into the terminal scrollback,
 * which survives tab switches (the terminal stays mounted while hidden).
 */
export function PreviewPanel() {
  const { status, previewUrl, error, reset } = useRuntime();
  const [tab, setTab] = useState<SidebarTab>("preview");
  const [frameKey, setFrameKey] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const [isResizing, setIsResizing] = useState(false);
  // Preview chrome follows the app theme by default; "light"/"dark" force
  // the surface explicitly. The framed app itself always renders as designed.
  const [appearance, setAppearance] = useState<PreviewAppearance>("system");
  const { resolvedTheme } = useTheme();
  const previewDark =
    appearance === "dark" || (appearance === "system" && resolvedTheme === "dark");

  const cycleAppearance = useCallback(() => {
    setAppearance((prev) => {
      const next =
        APPEARANCE_ORDER[(APPEARANCE_ORDER.indexOf(prev) + 1) % APPEARANCE_ORDER.length]!;
      return next;
    });
  }, []);

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
    <div className="flex h-full shrink-0 overflow-hidden">
      <div
        onMouseDown={handleResizeStart}
        className={`w-1 shrink-0 cursor-col-resize transition-colors hover:bg-primary/20 ${isResizing ? "bg-primary/20" : ""}`}
      />
      <aside
        style={{ width: sidebarWidth }}
        className="flex h-full flex-col overflow-hidden border-l bg-card"
      >
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
        <span className="flex items-center gap-1.5" data-testid="runtime-status">
          <span
            className={`size-2 rounded-full ${
              status === "ready"
                ? "bg-green-500"
                : status === "error"
                  ? "bg-red-500"
                  : "bg-yellow-500 animate-pulse"
            }`}
          />
          {status}
        </span>
      </div>

      {tab === "preview" && (
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
          <button
            onClick={cycleAppearance}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={`Preview appearance: ${appearance} (click to change)`}
          >
            {appearance === "light" ? (
              <Sun className="size-3.5" />
            ) : appearance === "dark" ? (
              <Moon className="size-3.5" />
            ) : (
              <Monitor className="size-3.5" />
            )}
          </button>
          <a
            href={previewUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!previewUrl}
            onClick={(e) => {
              if (!previewUrl) e.preventDefault();
            }}
            className={`rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground ${!previewUrl ? "pointer-events-none opacity-40" : ""}`}
            title="Open in new tab"
          >
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      )}

      <div className="min-h-0 flex-1 bg-background">
        {/* Kept mounted so the shell survives tab switches; the
            ResizeObserver in TerminalPanel re-fits on reveal. */}
        <div className={`h-full w-full ${tab === "terminal" ? "" : "hidden"}`}>
          <TerminalPanel active={tab === "terminal"} />
        </div>
        {tab === "preview" &&
          (previewUrl ? (
            <div
              className={`h-full w-full ${previewDark ? "bg-[#0c0c0c]" : "bg-white"}`}
              style={{ colorScheme: previewDark ? "dark" : "light" }}
            >
              <iframe
                key={frameKey}
                title="preview"
                src={previewUrl}
                className="h-full w-full border-0 bg-transparent"
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
                    Check the Terminal tab for details.
                  </span>
                  <button
                    onClick={reset}
                    className="mt-1 flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
                  >
                    <RotateCcw className="size-3.5" />
                    Retry boot
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
          ))}
      </div>
      </aside>
    </div>
  );
}
