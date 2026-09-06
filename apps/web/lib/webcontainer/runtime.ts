"use client";

import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { TEMPLATE_RUNTIME } from "@repo/templates/runtime";
import type { TemplateId } from "@repo/templates/runtime";
import { normalizeDbPath } from "@/lib/workspace/paths";
import { getWebContainer } from "./client";
import { toFileSystemTree } from "./files";
import type { ContainerDbFile } from "./types";

export type { TemplateId };
export type OutputHandler = (data: string) => void;

const TEMPLATE_IDS: readonly TemplateId[] = [
  "REACT",
  "VUE",
  "HONO",
  "EXPRESS",
  "NEXTJS",
  "ANGULAR",
];

/** Validate an unknown template value (e.g. from the project API). */
export function parseTemplateId(value: unknown): TemplateId {
  return TEMPLATE_IDS.includes(value as TemplateId)
    ? (value as TemplateId)
    : "REACT";
}

/** Templates whose language service is React-based (react typings apply). */
export function isReactFamily(template: string): boolean {
  return template === "REACT" || template === "NEXTJS";
}

export interface ShellHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onExit: Promise<number>;
}

async function pipeOutput(
  stream: ReadableStream<string>,
  onOutput?: OutputHandler,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onOutput?.(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Step 1 — one project runtime. Created once per editor page
 * (see runtime-provider); never boot() twice on the same page.
 */
export class ProjectRuntime {
  private container: WebContainer | null = null;
  private serverReadyUnsub: (() => void) | null = null;
  private portUnsub: (() => void) | null = null;
  private devProcess: WebContainerProcess | null = null;
  private devOutput: OutputHandler | undefined;
  readonly template: TemplateId;

  constructor(template: TemplateId = "REACT") {
    this.template = template;
  }

  async boot(): Promise<WebContainer> {
    if (!this.container) {
      this.container = await getWebContainer();
    }
    return this.container;
  }

  getContainer(): WebContainer | null {
    return this.container;
  }

  /** Mount the full project tree (wiping previous container FS state). */
  async mount(files: ContainerDbFile[]): Promise<void> {
    const container = await this.boot();
    await container.mount(toFileSystemTree(files));
  }

  /** Single npm install. Returns exit code. Only call on boot or package.json change. */
  async install(onOutput?: OutputHandler): Promise<number> {
    const container = await this.boot();
    const [cmd, ...args] = TEMPLATE_RUNTIME[this.template].install;
    const process = await container.spawn(cmd!, args);
    const piping = pipeOutput(process.output, onOutput);
    const code = await process.exit;
    await piping;
    return code;
  }

  /** Start the dev server (no await on exit — long-lived). */
  async startDevServer(onOutput?: OutputHandler): Promise<void> {
    const container = await this.boot();
    this.devOutput = onOutput ?? this.devOutput;
    const [cmd, ...args] = TEMPLATE_RUNTIME[this.template].start;
    const process = await container.spawn(cmd!, args);
    this.devProcess = process;
    void pipeOutput(process.output, this.devOutput);
    void process.exit.then(() => {
      if (this.devProcess === process) this.devProcess = null;
    });
  }

  /** Kill the running dev server (if any). Never throws. */
  stopDevServer(): void {
    if (this.devProcess) {
      try {
        this.devProcess.kill();
      } catch {
        // already exited
      }
      this.devProcess = null;
    }
  }

  /** Kill the running dev server (if any) and start a fresh one. */
  async restartDevServer(onOutput?: OutputHandler): Promise<void> {
    this.devOutput = onOutput ?? this.devOutput;
    if (this.devProcess) {
      try {
        this.devProcess.kill();
      } catch {
        // already exited — fall through to fresh start
      }
      this.devProcess = null;
    }
    await this.startDevServer(this.devOutput);
  }

  /** Interactive shell (`jsh`) for the xterm terminal panel. */
  async spawnShell(
    cols: number,
    rows: number,
    onOutput?: OutputHandler,
  ): Promise<ShellHandle> {
    const container = await this.boot();
    const proc = await container.spawn("jsh", [], {
      terminal: { cols, rows },
      // Pin a clean prompt; the default renders the container id as cwd
      // (`~/<id>`). Ignored if the shell doesn't honor PS1.
      env: { PS1: "~/project ❯ " },
    });
    void pipeOutput(proc.output, onOutput);

    const writer = proc.input.getWriter();
    let closed = false;
    const release = () => {
      try {
        writer.releaseLock();
      } catch {
        // already released
      }
    };
    void proc.exit.then(() => {
      closed = true;
      release();
    });

    return {
      write: (data: string) => {
        if (!closed) {
          writer.write(data).catch(() => {
            // shell gone — output stream already ended
          });
        }
      },
      resize: (c: number, r: number) => {
        try {
          proc.resize({ cols: c, rows: r });
        } catch {
          // shell gone
        }
      },
      kill: () => {
        closed = true;
        try {
          proc.kill();
        } catch {
          // already exited
        }
        release();
      },
      onExit: proc.exit,
    };
  }

  onServerReady(cb: (port: number, url: string) => void): void {
    if (!this.container) return;
    this.serverReadyUnsub?.();
    const off = (this.container as WebContainer).on(
      "server-ready",
      (port: number, url: string) => cb(port, url),
    );
    this.serverReadyUnsub = typeof off === "function" ? off : null;
  }

  /**
   * Port open/close events. Used to detect the dev server dying
   * (Ctrl+C / terminal close) so the preview can show a stopped state.
   */
  onPort(cb: (port: number, type: "open" | "close", url: string) => void): void {
    if (!this.container) return;
    this.portUnsub?.();
    const off = (this.container as WebContainer).on(
      "port",
      (port: number, type: "open" | "close", url: string) => cb(port, type, url),
    );
    this.portUnsub = typeof off === "function" ? off : null;
  }

  expectedPort(): number {
    return TEMPLATE_RUNTIME[this.template].port;
  }

  /** Hot path: every keystroke-debounce writes here, never npm install. */
  async writeFile(dbPath: string, content: string): Promise<void> {
    const container = await this.boot();
    const rel = normalizeDbPath(dbPath);
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    if (dir) {
      await container.fs.mkdir(dir, { recursive: true });
    }
    await container.fs.writeFile(rel, content);
  }

  async mkdir(dbPath: string): Promise<void> {
    const container = await this.boot();
    await container.fs.mkdir(normalizeDbPath(dbPath), { recursive: true });
  }

  async rm(dbPath: string, recursive = true): Promise<void> {
    const container = await this.boot();
    await container.fs.rm(normalizeDbPath(dbPath), { recursive });
  }

  teardown(): void {
    this.serverReadyUnsub?.();
    this.serverReadyUnsub = null;
    this.portUnsub?.();
    this.portUnsub = null;
    if (this.devProcess) {
      try {
        this.devProcess.kill();
      } catch {
        // ignore — container is going away
      }
      this.devProcess = null;
    }
    this.container = null;
  }
}

export const projectRuntime = new ProjectRuntime();
