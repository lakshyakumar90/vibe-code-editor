"use client";

import * as React from "react";
import { ProjectRuntime } from "@/lib/webcontainer/runtime";
import type { TemplateId } from "@/lib/webcontainer/runtime";
import type {
  ContainerDbFile,
  RuntimeStatus,
} from "@/lib/webcontainer/types";
import { appendCleanedLog } from "@/lib/webcontainer/output";

interface RuntimeContextValue {
  runtime: ProjectRuntime;
  status: RuntimeStatus;
  previewUrl: string | null;
  logs: string[];
  error: string | null;
  bootAndMount: (files: ContainerDbFile[]) => Promise<void>;
  install: () => Promise<void>;
  start: () => Promise<void>;
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

  const bootAndMount = React.useCallback(
    async (files: ContainerDbFile[]) => {
      if (bootedRef.current) return;
      bootedRef.current = true;
      setError(null);
      try {
        setStatus("booting");
        await runtime.boot();
        setStatus("mounting");
        await runtime.mount(files);
        runtime.onServerReady((_port, url) => {
          setPreviewUrl(url);
          setStatus("ready");
        });
      } catch (e) {
        bootedRef.current = false;
        setError(e instanceof Error ? e.message : "Boot failed");
        setStatus("error");
        throw e;
      }
    },
    [runtime],
  );

  const install = React.useCallback(async () => {
    setError(null);
    try {
      setStatus("installing");
      const code = await runtime.install(appendLog(setLogs));
      if (code !== 0) {
        throw new Error(`npm install failed with exit code ${code}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Install failed");
      setStatus("error");
      throw e;
    }
  }, [runtime]);

  const start = React.useCallback(async () => {
    setError(null);
    try {
      setStatus("starting");
      await runtime.startDevServer(appendLog(setLogs));
      // status flips to "ready" on server-ready event
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dev server failed");
      setStatus("error");
      throw e;
    }
  }, [runtime]);

  React.useEffect(() => {
    return () => {
      runtime.teardown();
      bootedRef.current = false;
    };
  }, [runtime]);

  const reset = React.useCallback(() => {
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
      install,
      start,
      reset,
    }),
    [runtime, status, previewUrl, logs, error, bootAndMount, install, start, reset],
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
