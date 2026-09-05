"use client";

import { useEffect, useRef } from "react";
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
 * Interactive WebContainer shell (`jsh`) via xterm.js.
 * Mounts once; the shell spawns as soon as the container has booted.
 */
export function TerminalPanel() {
  const { runtime, status } = useRuntime();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const shellRef = useRef<ShellHandle | null>(null);
  const spawnStartedRef = useRef(false);

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
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const dataDisposer = term.onData((data) => {
      shellRef.current?.write(data);
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
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

  // Spawn the shell once the container exists.
  useEffect(() => {
    if (status === "idle" || status === "booting" || status === "error") return;
    const term = termRef.current;
    if (!term || spawnStartedRef.current) return;
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
  }, [runtime, status]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <div ref={hostRef} className="h-full w-full p-1" />
      {(status === "idle" || status === "booting") && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-xs text-muted-foreground">
          Waiting for WebContainer…
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
