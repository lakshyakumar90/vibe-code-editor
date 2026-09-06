"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";
import { TerminalInstance } from "./terminal-panel";
import { AIPanel } from "./ai-panel";
import { BOOT_TERMINAL_ID, useRuntime } from "./runtime-provider";
import type { AttachableFile } from "@/lib/ai/types";
import type { Attachment } from "@repo/ai";

const AI_TAB_ID = "ai";

interface TermTab {
  id: string;
  title: string;
}

const PANEL_HEIGHT = 240;
let termCounter = 1;

/**
 * Bottom panel: one tab per open terminal, each closable, plus a way to
 * spawn new terminals. Collapse/expand chevron on the far right.
 *
 * Install (`❯ npm install`) and dev-server (`❯ npm run dev`) output is
 * mirrored into Terminal 1's scrollback (read-only log view); Ctrl+C there
 * stops the dev server and the preview. Other terminals are clean
 * interactive shells. Closing any tab never kills the dev server.
 *
 * Each terminal tab owns an independent xterm instance + jsh process.
 * Instances stay mounted while hidden so shells persist across tab
 * switches; closing a tab kills that process.
 *
 * The pinned AI tab hosts the assistant panel (Ask/Plan/Agent). It stays
 * mounted while hidden so chat state survives tab switches.
 */
export function BottomPanel({
  projectId,
  attachables,
  aiAttachments,
  onAiAttachmentsConsumed,
  aiRevealToken,
}: {
  projectId: string;
  attachables: AttachableFile[];
  /** Ask-AI selections from the editor (consumed into chips). */
  aiAttachments: Attachment[];
  onAiAttachmentsConsumed: () => void;
  /** Bumped to focus the AI tab (e.g. after Ask-AI). */
  aiRevealToken: number;
}) {
  const { logs, status } = useRuntime();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const [terminals, setTerminals] = useState<TermTab[]>(() => [
    { id: BOOT_TERMINAL_ID, title: "Terminal 1" },
  ]);
  const [active, setActive] = useState<string>(BOOT_TERMINAL_ID);
  const [collapsed, setCollapsed] = useState(false);

  const spawnTerminal = useCallback(() => {
    termCounter += 1;
    const id = `terminal-${termCounter}`;
    setTerminals((prev) => [...prev, { id, title: `Terminal ${prev.length + 1}` }]);
    setActive(id);
    setCollapsed(false);
  }, []);

  const closeTerminal = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      // The dev server is a detached process — closing any terminal tab
      // (including Terminal 1, now a read-only log view) never kills it.
      // Unmount disposes that tab's xterm instance only.
      setTerminals((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (active === id && next.length > 0) {
          setActive(next.at(-1)!.id);
        }
        return next;
      });
    },
    [active],
  );

  // Restart / (re)install runs headless — make sure its output is visible:
  // recreate Terminal 1 if closed, focus it, and expand the panel.
  useEffect(() => {
    if (status === "installing" || status === "starting") {
      setTerminals((prev) => {
        if (prev.some((t) => t.id === BOOT_TERMINAL_ID)) return prev;
        return [{ id: BOOT_TERMINAL_ID, title: "Terminal 1" }, ...prev];
      });
      setActive(BOOT_TERMINAL_ID);
      setCollapsed(false);
    }
  }, [status]);

  // Ask-AI from the editor focuses the AI tab (skips the initial 0).
  const revealSeenRef = useRef(aiRevealToken);
  useEffect(() => {
    if (aiRevealToken !== revealSeenRef.current) {
      revealSeenRef.current = aiRevealToken;
      setActive(AI_TAB_ID);
      setCollapsed(false);
    }
  }, [aiRevealToken]);

  const running = status === "ready";
  const busy =
    status === "installing" || status === "starting" || status === "mounting" || status === "booting";

  const surface = dark ? "bg-[#0c0c0c]" : "bg-white";
  const tabBtn = (isActive: boolean) =>
    `flex h-full shrink-0 items-center gap-1.5 border-r px-3 text-xs cursor-pointer ${
      isActive
        ? `${surface} text-foreground`
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="shrink-0 border-t bg-background">
      {/* Tab bar */}
      <div className="flex h-9 items-stretch overflow-x-auto border-b bg-muted/40">
        <button
          onClick={() => {
            setActive(AI_TAB_ID);
            setCollapsed(false);
          }}
          className={tabBtn(active === AI_TAB_ID)}
          title="AI assistant (Ask / Plan / Agent)"
        >
          <Bot className="size-3.5" />
          <span>AI</span>
        </button>
        {terminals.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setActive(t.id);
              setCollapsed(false);
            }}
            className={tabBtn(active === t.id)}
            title={
              t.id === BOOT_TERMINAL_ID
                ? "Terminal 1 (dev server output — Ctrl+C stops it)"
                : t.title
            }
          >
            <TerminalSquare className="size-3.5" />
            <span className="max-w-[120px] truncate">{t.title}</span>
            <span
              role="button"
              aria-label={`Close ${t.title}`}
              onClick={(e) => closeTerminal(t.id, e)}
              className="ml-1 rounded p-0.5 hover:bg-accent"
            >
              <X className="size-3.5" />
            </span>
          </button>
        ))}
        <button
          onClick={spawnTerminal}
          className="flex h-full shrink-0 items-center gap-1 px-3 text-xs text-muted-foreground hover:text-foreground"
          title="New terminal"
        >
          <Plus className="size-3.5" />
          <span>New terminal</span>
        </button>
        <div className="flex-1" />
        {/* Dev server state: running while the boot shell hosts vite. */}
        <span
          className="flex h-full shrink-0 items-center gap-1.5 px-3 text-xs text-muted-foreground"
          title={running ? "Dev server running" : `Dev server ${status}`}
        >
          <span
            className={`size-2 rounded-full ${
              running
                ? "bg-green-500"
                : status === "error"
                  ? "bg-red-500"
                  : busy
                    ? "bg-yellow-500 animate-pulse"
                    : "bg-muted-foreground/40"
            }`}
          />
          {running ? "running" : status}
        </span>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex h-full shrink-0 items-center px-3 text-muted-foreground hover:text-foreground"
          title={collapsed ? "Expand panel" : "Collapse panel"}
        >
          {collapsed ? (
            <ChevronUp className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </button>
      </div>

      {/* Content */}
      {!collapsed && (
        <div style={{ height: PANEL_HEIGHT }} className={surface}>
          {/* AI panel: stays mounted (hidden when inactive) so chat survives */}
          <div className={`h-full w-full ${active === AI_TAB_ID ? "" : "hidden"}`}>
            <AIPanel
              projectId={projectId}
              attachables={attachables}
              externalAttachments={aiAttachments}
              onExternalConsumed={onAiAttachmentsConsumed}
            />
          </div>
          {terminals.length === 0 && active !== AI_TAB_ID && (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              No terminals open.
              <button
                onClick={spawnTerminal}
                className="rounded bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/90"
              >
                Open terminal
              </button>
            </div>
          )}
          {/* Terminals: stay mounted (hidden when inactive) so shells persist */}
          {terminals.map((t) => (
            <div
              key={t.id}
              className={`h-full w-full ${active === t.id ? "" : "hidden"}`}
            >
              <TerminalInstance
                id={t.id}
                active={active === t.id && !collapsed}
                feedLogs={t.id === BOOT_TERMINAL_ID ? logs : undefined}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
