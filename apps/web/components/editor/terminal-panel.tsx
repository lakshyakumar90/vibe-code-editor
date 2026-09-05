"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "next-themes";
import { useRuntime } from "./runtime-provider";
import type { ShellHandle } from "@/lib/webcontainer/runtime";

function terminalTheme(dark: boolean) {
  return dark
    ? {
        background: "#0c0c0c",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#3a3a3a",
      }
    : {
        background: "#ffffff",
        foreground: "#1f1f1f",
        cursor: "#1f1f1f",
        selectionBackground: "#d7e3f4",
      };
}

/**
 * Write stored log chunks into the terminal (newlines normalized for xterm).
 * Returns the new write index. Terminal scrollback persists across tab
 * switches because this component stays mounted.
 */
function writeLogs(term: Terminal, logs: string[], from: number): number {
  let idx = from;
  for (; idx < logs.length; idx++) {
    term.write(logs[idx]!.replace(/\n/g, "\r\n"));
  }
  return idx;
}

/**
 * Interactive WebContainer shell (`jsh`) via xterm.js.
 * Mounts once; the shell spawns when the panel is actually visible with
 * sane dimensions. Spawning while hidden yields 0-width dims and garbles
 * the shell's prompt rendering.
 *
 * Install/dev process logs are mirrored into the same scrollback so there
 * is a single persistent terminal surface (no separate Output view).
 */
export function TerminalPanel({ active }: { active: boolean }) {
  const { runtime, status, logs } = useRuntime();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const shellRef = useRef<ShellHandle | null>(null);
  const spawnStartedRef = useRef(false);
  const logIndexRef = useRef(0);
  const logsRef = useRef(logs);
  logsRef.current = logs;
  /** True once the host has a real size (panel visible). */
  const [sized, setSized] = useState(false);

  // Terminal lifecycle — created once per mount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: terminalTheme(false),
      scrollback: 1000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // Skip fitting while hidden (0-width host produces garbage dims).
    if (host.clientWidth > 0) {
      fit.fit();
      setSized(true);
    }

    termRef.current = term;
    fitRef.current = fit;
    // Drain any process logs that arrived before the terminal existed.
    logIndexRef.current = writeLogs(term, logsRef.current, 0);

    const dataDisposer = term.onData((data) => {
      shellRef.current?.write(data);
    });
    const observer = new ResizeObserver(() => {
      const el = hostRef.current;
      // Hidden or collapsed — don't fit, don't resize the pty.
      if (!el || el.clientWidth < 50) return;
      try {
        fit.fit();
        setSized(true);
        const t = termRef.current;
        if (t) shellRef.current?.resize(t.cols, t.rows);
      } catch {
        // host collapsing during layout — ignore
      }
    });
    observer.observe(host);

    return () => {
      dataDisposer.dispose();
      observer.disconnect();
      shellRef.current?.kill();
      shellRef.current = null;
      spawnStartedRef.current = false;
      setSized(false);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Follow the app theme without recreating the terminal.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = terminalTheme(dark);
    }
  }, [dark]);

  // Mirror install/dev process logs into the scrollback. The terminal
  // stays mounted across tab switches, so history persists.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (logs.length < logIndexRef.current) {
      // Logs were cleared (retry) — reset the surface too.
      term.clear();
      logIndexRef.current = 0;
    }
    logIndexRef.current = writeLogs(term, logs, logIndexRef.current);
  }, [logs]);

  // Spawn the shell once the container exists AND the panel is visible
  // with sane dimensions. Re-runs on tab reveal (via `sized`/`active`).
  useEffect(() => {
    if (!active || !sized) return;
    if (status === "idle" || status === "booting" || status === "error") return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || spawnStartedRef.current || shellRef.current) return;
    // Re-fit now that we're visible; bail if dims are still broken.
    try {
      fit.fit();
    } catch {
      return;
    }
    if (term.cols < 10 || term.rows < 3) return;
    spawnStartedRef.current = true;

    void (async () => {
      try {
        const shell = await runtime.spawnShell(term.cols, term.rows, (data) => {
          term.write(data);
        });
        shellRef.current = shell;
        void shell.onExit.then(() => {
          shellRef.current = null;
          term.writeln("\r\n[terminal] shell exited.");
        });
      } catch {
        term.writeln("\r\n[terminal] shell failed to start.");
        spawnStartedRef.current = false;
      }
    })();
  }, [runtime, status, active, sized]);

  const waiting =
    status === "idle" || status === "booting" || !active || !sized;

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <div ref={hostRef} className="h-full w-full p-1" />
      {waiting && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-xs text-muted-foreground">
          {status === "idle" || status === "booting"
            ? "Waiting for WebContainer…"
            : "Open the Terminal tab to start a shell…"}
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-4 text-center text-xs text-muted-foreground">
          Terminal unavailable — runtime failed to boot.
        </div>
      )}
    </div>
  );
}
