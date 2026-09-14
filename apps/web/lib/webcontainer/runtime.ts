"use client";

import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { TEMPLATE_RUNTIME } from "@repo/templates/runtime";
import type { TemplateId } from "@repo/templates/runtime";
import { normalizeDbPath } from "@/lib/workspace/paths";
import { getWebContainer } from "./client";
import { toFileSystemTree } from "./files";
import {
  parseGitVersion,
  shouldUseGitShim,
  type NativeGitProbe,
} from "./git-capability";
import { splitCommand } from "./terminal-git";
import type { ContainerDbFile } from "./types";

export type { TemplateId };
export type { NativeGitProbe };
export { shouldUseGitShim };

export interface TerminalGitIdentity {
  name?: string;
  email?: string;
}

export interface TerminalGitResult {
  exitCode: number;
  output: string;
}

/** Container path of the bundled shim (hidden dir, never synced to DB). */
export const TERMINAL_GIT_SHIM_PATH = ".vibe/git-shim.cjs";
const TERMINAL_GIT_URL = "/vibe/git-shim.cjs";
const TERMINAL_GIT_TIMEOUT_MS = 60_000;
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
 * Shell splitter lives in terminal-git.ts (dependency-free, unit-tested);
 * re-exported here so existing importers keep working.
 */
export { splitCommand } from "./terminal-git";

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
  /** Cached `git --version` probe; reset on teardown (container is gone). */
  private nativeGitProbe: NativeGitProbe | null = null;
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

  /**
   * Future-proofing probe: does this WebContainer release ship a native `git`
   * binary? Spawns `git --version` once per container (cached), with a short
   * timeout so a missing binary never blocks boot. Never throws — returns
   * `{ available: false, version: null }` on any failure (spawn error,
   * non-zero exit, unparsable output, timeout).
   *
   * When `available` is true, the JS git shim must disable itself and defer
   * to the real CLI (see `shouldUseGitShim`). Fire-and-forget from the boot
   * path; diagnostic only.
   */
  async probeNativeGit(timeoutMs = 10_000): Promise<NativeGitProbe> {
    if (this.nativeGitProbe) return this.nativeGitProbe;
    const unavailable: NativeGitProbe = { available: false, version: null };
    try {
      const container = await this.boot();
      const proc = await container.spawn("git", ["--version"]);
      let output = "";
      const reader = proc.output.getReader();
      const collect = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (output.length < 500) output += value;
          }
        } finally {
          reader.releaseLock();
        }
      })();
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), timeoutMs),
      );
      const exit = await Promise.race([proc.exit, timeout]);
      if (exit === "timeout") {
        try {
          proc.kill();
        } catch {
          // already exited
        }
        await collect.catch(() => {});
        this.nativeGitProbe = unavailable;
        return this.nativeGitProbe;
      }
      await collect;
      const version = exit === 0 ? parseGitVersion(output) : null;
      this.nativeGitProbe =
        version !== null ? { available: true, version } : unavailable;
    } catch {
      this.nativeGitProbe = unavailable;
    }
    return this.nativeGitProbe;
  }

  /** Last probe result (null before the first probe settles). */
  getNativeGitProbe(): NativeGitProbe | null {
    return this.nativeGitProbe;
  }

  /**
   * Ensure the terminal git shim script exists in the container FS.
   * Fetches the bundled script (built by `pnpm shim:build`, no secrets)
   * and writes it to the hidden `.vibe/` dir — excluded from DB sync.
   * Throws when the bundle is missing (dev forgot `shim:build`); the
   * terminal surfaces a one-line hint instead of failing silently.
   */
  async ensureGitShim(): Promise<void> {
    const container = await this.boot();
    try {
      const st = await container.fs.readFile(TERMINAL_GIT_SHIM_PATH, "utf-8");
      if (st.length > 100_000) return;
    } catch {
      /* missing or stale — (re)deliver below */
    }
    const res = await fetch(TERMINAL_GIT_URL, { cache: "force-cache" });
    if (!res.ok) {
      throw new Error(
        "terminal git shim not built yet (run `pnpm --filter web shim:build`)",
      );
    }
    const text = await res.text();
    if (text.length < 100_000 || !text.includes("vibe-shim")) {
      throw new Error("terminal git shim bundle looks invalid; rebuild it");
    }
    await container.fs.mkdir(".vibe", { recursive: true });
    await container.fs.writeFile(TERMINAL_GIT_SHIM_PATH, text);
  }

  /**
   * Run one terminal `git` shim invocation (one-shot node process).
   * Only identity env is forwarded — never tokens or server git config.
   * Resolves with exit code + combined output; rejects on timeout/spawn
   * failure. Callers trigger a container→DB rescan for mutating commands.
   */
  async runTerminalGit(
    argv: string[],
    identity: TerminalGitIdentity = {},
    onOutput?: OutputHandler,
  ): Promise<TerminalGitResult> {
    await this.ensureGitShim();
    const container = await this.boot();
    const env: Record<string, string> = {};
    if (identity.name) env["VIBE_GIT_NAME"] = identity.name;
    if (identity.email) env["VIBE_GIT_EMAIL"] = identity.email;
    const proc = await container.spawn("node", [TERMINAL_GIT_SHIM_PATH, ...argv], {
      cwd: "/",
      env,
    });
    let output = "";
    const OUT_CAP = 20000;
    const collect = (chunk: string) => {
      if (output.length < OUT_CAP) output += chunk.slice(0, OUT_CAP - output.length);
      onOutput?.(chunk);
    };
    const piping = pipeOutput(proc.output, collect);
    const exitCode = await Promise.race([
      proc.exit,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), TERMINAL_GIT_TIMEOUT_MS),
      ),
    ]);
    if (exitCode === "timeout") {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      await piping;
      throw new Error("terminal git timed out");
    }
    await piping;
    return { exitCode, output };
  }

  /**
   * Point the terminal repo's `origin` at a validated non-secret URL
   * (called after Add Remote / Publish). Best-effort: silent no-op when
   * the shim is unavailable or no local terminal repo exists yet.
   */
  async setShimRemote(url: string): Promise<void> {
    try {
      await this.runTerminalGit(["__sync-remote", url]);
    } catch {
      // terminal convenience only — server binding is authoritative
    }
  }

  /**
   * Idempotent local convenience repo (Strategy A): init + snapshot commit
   * when the container has no `.git` yet. Best-effort, never throws.
   */
  async ensureTerminalGit(identity: TerminalGitIdentity = {}): Promise<void> {
    try {
      await this.runTerminalGit(["__ensure-snapshot"], identity);
    } catch {
      // terminal convenience only
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
    this.nativeGitProbe = null;
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
