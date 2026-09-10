"use client";

import * as React from "react";
import { ProjectRuntime } from "@/lib/webcontainer/runtime";
import { describeBootFailure, resetWebContainerCache } from "@/lib/webcontainer/client";
import type { TemplateId } from "@/lib/webcontainer/runtime";
import { TEMPLATE_RUNTIME } from "@repo/templates/runtime";
import type {
  ContainerDbFile,
  RuntimeStatus,
} from "@/lib/webcontainer/types";
import { appendCleanedLog } from "@/lib/webcontainer/output";

/** First terminal tab; the dev server's log surface + Ctrl+C target. */
export const BOOT_TERMINAL_ID = "terminal-1";

interface RuntimeContextValue {
  runtime: ProjectRuntime;
  status: RuntimeStatus;
  previewUrl: string | null;
  logs: string[];
  error: string | null;
  bootAndMount: (files: ContainerDbFile[]) => Promise<void>;
  /** `npm install && npm run dev` as managed processes (echoed to logs). */
  runBootChain: () => Promise<void>;
  /** Stop a running dev server (Ctrl+C) and start it again. */
  restartDev: () => Promise<void>;
  /** Reinstall deps + restart dev (package.json changed). */
  reinstallAndRestart: () => Promise<void>;
  /** Kill the dev server now (Ctrl+C / terminal close) → preview stops. */
  stopDev: () => void;
  /** Clear failure state so the editor can retry the boot sequence. */
  reset: () => void;
}

const RuntimeContext = React.createContext<RuntimeContextValue | null>(null);

function appendLog(setLogs: React.Dispatch<React.SetStateAction<string[]>>) {
  return (chunk: string) => {
    setLogs((prev) => appendCleanedLog(prev, chunk));
  };
}

export function RuntimeProvider({
  children,
  template = "REACT",
}: {
  children: React.ReactNode;
  template?: TemplateId;
}) {
  const runtimeRef = React.useRef<ProjectRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = new ProjectRuntime(template);
  }
  const runtime = runtimeRef.current;

  const [status, setStatus] = React.useState<RuntimeStatus>("idle");
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const bootedRef = React.useRef(false);
  const statusRef = React.useRef(status);
  statusRef.current = status;
  /** Set around intentional kills so their port-close is not a "stopped". */
  const expectCloseRef = React.useRef(false);

  const installCommand = React.useCallback(() => {
    return TEMPLATE_RUNTIME[runtime.template].install.join(" ");
  }, [runtime]);

  const devCommand = React.useCallback(() => {
    return TEMPLATE_RUNTIME[runtime.template].start.join(" ");
  }, [runtime]);

  const bootAndMount = React.useCallback(
    async (files: ContainerDbFile[]) => {
      if (bootedRef.current) return;
      bootedRef.current = true;
      setError(null);
      try {
        setStatus("booting");
        // Boot flakes (CDN/worklet load, resource contention) — retry a few
        // times with backoff before surfacing. Rejected boots are dropped
        // from the container cache, so each attempt is a fresh boot.
        let booted = false;
        for (let attempt = 1; attempt <= 3 && !booted; attempt += 1) {
          try {
            await runtime.boot();
            booted = true;
          } catch (e) {
            if (attempt === 3) throw e;
            await new Promise((r) => setTimeout(r, 1500 * attempt));
          }
        }
        setStatus("mounting");
        await runtime.mount(files);
        runtime.onServerReady((_port, url) => {
          setPreviewUrl(url);
          setStatus("ready");
        });
        // The dev server dying (Ctrl+C / terminal close / crash) stops
        // the preview. Intentional kills set expectCloseRef first.
        const expectedPort = runtime.expectedPort();
        runtime.onPort((port, type) => {
          if (port !== expectedPort || type !== "close") return;
          if (expectCloseRef.current) {
            expectCloseRef.current = false;
            return;
          }
          const s = statusRef.current;
          if (s === "ready" || s === "starting") {
            setPreviewUrl(null);
            setStatus("stopped");
          }
        });
      } catch (e) {
        bootedRef.current = false;
        setError(describeBootFailure(e));
        setStatus("error");
        throw e;
      }
    },
    [runtime],
  );

  const runBootChain = React.useCallback(async () => {
    setError(null);
    const push = appendLog(setLogs);
    try {
      // Echoed so the boot terminal reads like a real session:
      // `~/project ❯ npm install` … output … `~/project 23s ❯ npm run dev`.
      setStatus("installing");
      push(`~/project\n❯ ${installCommand()}\n`);
      const t0 = Date.now();
      const code = await runtime.install(push);
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      push(`\n~/project ${secs}s\n`);
      if (code !== 0) {
        throw new Error(`npm install failed with exit code ${code}`);
      }
      setStatus("starting");
      push(`❯ ${devCommand()}\n`);
      await runtime.startDevServer(push);
      // status flips to "ready" on server-ready event
    } catch (e) {
      setError(e instanceof Error ? e.message : "Boot failed");
      setStatus("error");
      throw e;
    }
  }, [runtime, installCommand, devCommand]);

  const stopDev = React.useCallback(() => {
    runtime.stopDevServer();
    const s = statusRef.current;
    if (s === "ready" || s === "starting") {
      setPreviewUrl(null);
      setStatus("stopped");
    }
  }, [runtime]);

  const restartDev = React.useCallback(async () => {
    setError(null);
    const push = appendLog(setLogs);
    try {
      setStatus("starting");
      push(`❯ ${devCommand()}\n`);
      expectCloseRef.current = true;
      await runtime.restartDevServer(push);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dev server failed");
      setStatus("error");
      throw e;
    }
  }, [runtime, devCommand]);

  const reinstallAndRestart = React.useCallback(async () => {
    setError(null);
    const push = appendLog(setLogs);
    try {
      setStatus("installing");
      push(`~/project\n❯ ${installCommand()}\n`);
      const t0 = Date.now();
      const code = await runtime.install(push);
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      push(`\n~/project ${secs}s\n`);
      if (code !== 0) {
        throw new Error(`npm install failed with exit code ${code}`);
      }
      setStatus("starting");
      push(`❯ ${devCommand()}\n`);
      expectCloseRef.current = true;
      await runtime.restartDevServer(push);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reinstall failed");
      setStatus("error");
      throw e;
    }
  }, [runtime, installCommand, devCommand]);

  React.useEffect(() => {
    return () => {
      runtime.teardown();
      bootedRef.current = false;
    };
  }, [runtime]);

  const reset = React.useCallback(() => {
    // Drop any poisoned boot so Retry boot starts clean (only called from
    // the error state, where the prior attempt already settled).
    resetWebContainerCache();
    bootedRef.current = false;
    setError(null);
    setPreviewUrl(null);
    setLogs([]);
    setStatus("idle");
  }, []);

  const value = React.useMemo(
    () => ({
      runtime,
      status,
      previewUrl,
      logs,
      error,
      bootAndMount,
      runBootChain,
      restartDev,
      reinstallAndRestart,
      stopDev,
      reset,
    }),
    [
      runtime,
      status,
      previewUrl,
      logs,
      error,
      bootAndMount,
      runBootChain,
      restartDev,
      reinstallAndRestart,
      stopDev,
      reset,
    ],
  );

  return (
    <RuntimeContext.Provider value={value}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useRuntime(): RuntimeContextValue {
  const ctx = React.useContext(RuntimeContext);
  if (!ctx) {
    throw new Error("useRuntime must be used inside RuntimeProvider");
  }
  return ctx;
}
