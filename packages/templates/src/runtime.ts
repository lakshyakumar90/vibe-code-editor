/**
 * Client-safe runtime config for every template: how WebContainer
 * installs dependencies, starts the dev server, and which port
 * the `server-ready` event is expected on.
 *
 * Pure data — no node builtins — so `apps/web` can import it in the
 * browser. Template file contents themselves still come from the DB
 * (seeded at project creation); this only describes how to RUN them.
 */
export type TemplateId =
  | "REACT"
  | "VUE"
  | "HONO"
  | "EXPRESS"
  | "NEXTJS"
  | "ANGULAR";

export interface TemplateRuntime {
  /** e.g. ["npm", "install"] — spawned as (cmd, args) via container.spawn() */
  install: string[];
  /** dev-server command, e.g. ["npm", "run", "dev"] */
  start: string[];
  /** container port the dev server listens on (each maps to its own preview URL) */
  port: number;
}

export const TEMPLATE_RUNTIME: Record<TemplateId, TemplateRuntime> = {
  // Vite (migrated from CRA in template v1.1.0). Port pinned with
  // --strictPort in package.json + vite.config.ts (host: true for forwarding).
  REACT: {
    install: ["npm", "install"],
    start: ["npm", "run", "dev"],
    port: 5173,
  },
  // vue-cli-service (webpack). Port pinned explicitly; fresh containers
  // are always free, but explicit beats silent auto-increment.
  VUE: {
    install: ["npm", "install"],
    start: ["npm", "run", "serve", "--", "--port", "8080"],
    port: 8080,
  },
  // tsx watch, port hardcoded 3000 in src/index.ts.
  HONO: {
    install: ["npm", "install"],
    start: ["npm", "run", "dev"],
    port: 3000,
  },
  // plain node, port hardcoded 3010 in index.js.
  EXPRESS: {
    install: ["npm", "install"],
    start: ["npm", "start"],
    port: 3010,
  },
  // Next 13. Binds all interfaces by default; pin port explicitly.
  NEXTJS: {
    install: ["npm", "install"],
    start: ["npm", "run", "dev", "--", "-p", "3000"],
    port: 3000,
  },
  // ng serve defaults to localhost:4200; pass host+port explicitly so
  // forwarding never depends on CLI defaults.
  ANGULAR: {
    install: ["npm", "install"],
    start: ["npm", "start", "--", "--host", "0.0.0.0", "--port", "4200"],
    port: 4200,
  },
};
