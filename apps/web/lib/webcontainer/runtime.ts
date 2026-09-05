"use client";

import type { WebContainer } from "@webcontainer/api";
import { TEMPLATE_RUNTIME } from "@repo/templates/runtime";
import type { TemplateId } from "@repo/templates/runtime";
import { normalizeDbPath } from "@/lib/workspace/paths";
import { getWebContainer } from "./client";
import { toFileSystemTree } from "./files";
import type { ContainerDbFile } from "./types";

export type { TemplateId };
export type OutputHandler = (data: string) => void;

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
    const [cmd, ...args] = TEMPLATE_RUNTIME[this.template].start;
    const process = await container.spawn(cmd!, args);
    void pipeOutput(process.output, onOutput);
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
    this.container = null;
  }
}

export const projectRuntime = new ProjectRuntime();
