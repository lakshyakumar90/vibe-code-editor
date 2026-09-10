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

/**
 * Minimal shell-like splitter: whitespace-separated, honoring single and
 * double quotes (no escapes, no operators — one command only).
 */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
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

  /**
   * Run one agent-approved command non-interactively and capture output.
   * Command is split on whitespace honoring single/double quotes.
   * Output capped at ~20k chars. Resolves with the exit code.
   */
  async runCommand(
    command: string,
    onOutput?: OutputHandler,
  ): Promise<{ exitCode: number; output: string }> {
    const container = await this.boot();
    const [cmd, ...args] = splitCommand(command);
    if (!cmd) throw new Error("Empty command");
    const proc = await container.spawn(cmd, args);
    let output = "";
    const OUT_CAP = 20000;
    const collect = (chunk: string) => {
      if (output.length < OUT_CAP) {
        output += chunk.slice(0, OUT_CAP - output.length);
      }
      onOutput?.(chunk);
    };
    const piping = pipeOutput(proc.output, collect);
    const exitCode = await proc.exit;
    await piping;
    return { exitCode, output };
  }

  /** Read a file from the container FS (null when missing/unreadable). */
  async readContainerFile(dbPath: string): Promise<string | null> {
    try {
      const container = await this.boot();
      return await container.fs.readFile(normalizeDbPath(dbPath), "utf-8");
    } catch {
      return null;
    }
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
      cwd: "/",
      // Pin a clean prompt; jsh largely ignores PS1, so the boot log
      // terminal is read-only (no shell) to avoid the `~/<id>` prompt.
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

  /** Build verification command for agent changesets (default: npm run build). */
  buildCommand(): string[] {
    return TEMPLATE_RUNTIME[this.template].build ?? ["npm", "run", "build"];
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
