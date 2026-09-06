"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "next-themes";
import { BOOT_TERMINAL_ID, useRuntime } from "./runtime-provider";
import type { ShellHandle } from "@/lib/webcontainer/runtime";

/** Follows the app theme (next-themes): dark terminal in dark mode. */
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
 * One independent shell session: its own xterm.js instance + FitAddon +
 * its own `jsh` process against the shared WebContainer.
 *
 * The component stays mounted (hidden when inactive) so the shell process
 * survives tab switches. The process is killed only on unmount, i.e. when
 * the user explicitly closes the tab. An optional `shells` registry lets
 * the parent track the Map<terminalId, ShellHandle>.
 */
/**
 * Write stored log chunks into the terminal (newlines normalized for xterm).
 * Returns the new write index.
 */
function writeLogs(term: Terminal, logs: string[], from: number): number {
  let idx = from;
  for (; idx < logs.length; idx++) {
    term.write(logs[idx]!.replace(/\n/g, "\r\n"));
  }
  return idx;
}

export function TerminalInstance({
  id,
  active,
  feedLogs,
}: {
  id: string;
  active: boolean;
  /** Boot/install/dev log chunks mirrored into this shell's scrollback. */
  feedLogs?: string[];
}) {
  const { runtime, status, stopDev } = useRuntime();
  // Ref mirrors: the mount/spawn effects must keep a fixed dep-array size
  // across renders (and HMR swaps) — React throws if it ever changes.
  const stopRef = useRef(stopDev);
  stopRef.current = stopDev;
  const statusRef = useRef(status);
  statusRef.current = status;
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  const hostRef = useRef<HTMLDivElement>(null);
  const logIndexRef = useRef(0);
  const feedLogsRef = useRef(feedLogs);
  feedLogsRef.current = feedLogs;
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const shellRef = useRef<ShellHandle | null>(null);
  const spawnStartedRef = useRef(false);
  const [sized, setSized] = useState(false);

  // Terminal lifecycle — created once per mount, disposed on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: terminalTheme(document.documentElement.classList.contains("dark")),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    if (host.clientWidth > 0) {
      try {
        fit.fit();
        setSized(true);
      } catch {
        // hidden on first mount — observer re-fits on reveal
      }
    }

    termRef.current = term;
    fitRef.current = fit;
    // Drain any boot logs that arrived before the terminal existed.
    logIndexRef.current = writeLogs(term, feedLogsRef.current ?? [], 0);

    const dataDisposer = term.onData((data) => {
      // Ctrl+C in the boot terminal stops the managed dev server (the
      // shell itself is idle — our dev process is detached). The byte is
      // still forwarded so any user-run foreground process sees it too.
      if (
        data.includes("\x03") &&
        id === BOOT_TERMINAL_ID &&
        (statusRef.current === "ready" || statusRef.current === "starting")
      ) {
        stopRef.current();
      }
      shellRef.current?.write(data);
    });
    const observer = new ResizeObserver(() => {
      const el = hostRef.current;
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
  }, [id]);

  // Follow the app theme without recreating the terminal.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = terminalTheme(dark);
    }
  }, [dark]);

  // Re-fit when revealed (hidden tabs have 0 width while inactive).
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    // Wait a frame so the container has layout.
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
        setSized(true);
        shellRef.current?.resize(term.cols, term.rows);
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // Spawn the shell once the container exists AND the panel is visible
  // with sane dimensions.
  useEffect(() => {
    if (!active || !sized) return;
    if (status === "idle" || status === "booting" || status === "error") return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || spawnStartedRef.current || shellRef.current) return;
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
          if (shellRef.current === shell) shellRef.current = null;
          term.writeln("\r\n[terminal] shell exited.");
        });
      } catch {
        term.writeln("\r\n[terminal] shell failed to start.");
        spawnStartedRef.current = false;
      }
    })();
  }, [runtime, status, active, sized, id]);

  // Mirror boot/install/dev logs into this shell's scrollback (e.g. the
  // first terminal shows `❯ npm install` + output). Persists across tab
  // switches since the instance stays mounted while hidden.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !feedLogs) return;
    if (feedLogs.length < logIndexRef.current) {
      term.clear();
      logIndexRef.current = 0;
    }
    logIndexRef.current = writeLogs(term, feedLogs, logIndexRef.current);
  }, [feedLogs]);

  const waiting =
    status === "idle" || status === "booting" || !active || !sized;

  return (
    <div
      className={`relative h-full w-full overflow-hidden ${dark ? "bg-[#0c0c0c]" : "bg-white"}`}
    >
      <div ref={hostRef} className="h-full w-full p-1" />
      {waiting && (
        <div
          className={`absolute inset-0 flex items-center justify-center text-xs text-muted-foreground ${dark ? "bg-[#0c0c0c]/80" : "bg-white/80"}`}
        >
          {status === "idle" || status === "booting"
            ? "Waiting for WebContainer…"
            : "Starting shell…"}
        </div>
      )}
      {status === "error" && (
        <div
          className={`absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground ${dark ? "bg-[#0c0c0c]/80" : "bg-white/80"}`}
        >
          Terminal unavailable — runtime failed to boot.
        </div>
      )}
    </div>
  );
}

/**
 * Legacy single-terminal entry (kept for compat; prefers TerminalInstance).
 */
export function TerminalPanel({ active }: { active: boolean }) {
  return <TerminalInstance id="terminal" active={active} />;
}
