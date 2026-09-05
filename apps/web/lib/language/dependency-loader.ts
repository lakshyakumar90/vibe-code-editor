import type * as Monaco from "monaco-editor";
import { hashPackageJson } from "@/lib/webcontainer/dependency-state";
import type { ProjectRuntime } from "@/lib/webcontainer/runtime";
import { workspaceToMonacoUri } from "@/lib/workspace/paths";
import { getSharedMonaco } from "./model-manager";

/**
 * Steps 8–9 — bridge installed node_modules declarations into Monaco.
 *
 * After `npm install`, declaration files live in the WebContainer FS but
 * Monaco's TS worker can't see them. We read each package's `package.json`
 * (`types`/`typings` entry, `index.d.ts` fallback) and register the files
 * via `addExtraLib` at `file:///project/node_modules/...` paths so the
 * worker's Node-style resolution finds them natively.
 *
 * Roots are per-template, plus one level of transitive dependencies
 * (e.g. `csstype` via `@types/react`, `mime` via `express`), capped so a
 * huge graph can't stall the UI. `skipLibCheck` (see ts-config) keeps any
 * remaining gaps from surfacing as errors.
 */

/** Root type packages per template. Null = deferred to a V2 language service. */
function getRootTypePackages(template: string): string[] | null {
  switch (template) {
    case "REACT":
    case "NEXTJS":
      return ["react", "react-dom", "@types/react", "@types/react-dom"];
    case "EXPRESS":
      return ["express", "@types/express", "@types/node"];
    case "HONO":
      return ["hono", "@types/node"];
    default:
      return null;
  }
}

/** Max packages to probe per load (roots + one transitive level). */
const MAX_PACKAGES = 15;

interface PendingLoad {
  runtime: ProjectRuntime;
  packageJsonContent: string;
}

let loadedHash = "";
let loading = false;
let pending: PendingLoad | null = null;
let extraLibs: Array<{ dispose(): void }> = [];
let activeTemplate = "REACT";

/** Template context for type loading (set by EditorLayout on boot). */
export function setActiveTemplate(template: string): void {
  activeTemplate = template;
}

async function readContainerText(
  runtime: ProjectRuntime,
  containerPath: string,
): Promise<string | null> {
  const container = runtime.getContainer();
  if (!container) return null;
  try {
    const data = await container.fs.readFile(containerPath, "utf-8");
    return typeof data === "string" ? data : null;
  } catch {
    return null;
  }
}

function cleanEntry(entry: string): string {
  return entry.replace(/^\.\//, "");
}

interface ResolvedPackage {
  files: Array<{ monacoPath: string; content: string }>;
  /** Runtime dependency names (for one-level transitive follow). */
  depNames: string[];
}

/** Main declaration file(s) + dependency names for one installed package. */
async function resolveDeclarationFiles(
  runtime: ProjectRuntime,
  pkg: string,
): Promise<ResolvedPackage> {
  const none: ResolvedPackage = { files: [], depNames: [] };
  const metaRaw = await readContainerText(
    runtime,
    `/node_modules/${pkg}/package.json`,
  );
  if (!metaRaw) return none;

  let meta: { types?: unknown; typings?: unknown; dependencies?: unknown };
  try {
    meta = JSON.parse(metaRaw) as {
      types?: unknown;
      typings?: unknown;
      dependencies?: unknown;
    };
  } catch {
    return none;
  }

  const depNames =
    meta.dependencies && typeof meta.dependencies === "object"
      ? Object.keys(meta.dependencies as Record<string, unknown>)
      : [];

  const candidates: string[] = [];
  if (typeof meta.types === "string") candidates.push(cleanEntry(meta.types));
  if (typeof meta.typings === "string" && meta.typings !== meta.types) {
    candidates.push(cleanEntry(meta.typings));
  }
  candidates.push("index.d.ts");

  const files: ResolvedPackage["files"] = [];
  for (const candidate of candidates) {
    const content = await readContainerText(
      runtime,
      `/node_modules/${pkg}/${candidate}`,
    );
    if (content !== null) {
      files.push({
        monacoPath: workspaceToMonacoUri(`node_modules/${pkg}/${candidate}`),
        content,
      });
      break;
    }
  }

  // React's automatic JSX runtime resolves './jsx-runtime' from react's
  // own types — register it explicitly so ReactJSX has full types.
  if (pkg === "react") {
    for (const extra of ["jsx-runtime.d.ts", "jsx-dev-runtime.d.ts"]) {
      const content = await readContainerText(
        runtime,
        `/node_modules/react/${extra}`,
      );
      if (content !== null) {
        files.push({
          monacoPath: workspaceToMonacoUri(`node_modules/react/${extra}`),
          content,
        });
      }
    }
  }

  return { files, depNames };
}

async function loadDependencyTypes(
  monaco: typeof Monaco,
  runtime: ProjectRuntime,
  roots: string[],
): Promise<number> {
  for (const lib of extraLibs) {
    try {
      lib.dispose();
    } catch {
      // ignore stale disposables
    }
  }
  extraLibs = [];

  // Roots first, then one transitive level (deps of roots only).
  const visited = new Set<string>();
  const queue: Array<{ pkg: string; depth: number }> = roots.map((pkg) => ({
    pkg,
    depth: 0,
  }));

  let count = 0;
  while (queue.length > 0 && visited.size < MAX_PACKAGES) {
    const { pkg, depth } = queue.shift()!;
    if (visited.has(pkg)) continue;
    visited.add(pkg);

    const resolved = await resolveDeclarationFiles(runtime, pkg);
    for (const file of resolved.files) {
      extraLibs.push(
        monaco.typescript.typescriptDefaults.addExtraLib(
          file.content,
          file.monacoPath,
        ),
      );
      count++;
    }
    if (depth === 0) {
      for (const dep of resolved.depNames) {
        if (!visited.has(dep)) queue.push({ pkg: dep, depth: 1 });
      }
    }
  }
  return count;
}

/**
 * Load (or reload, when package.json changed) dependency declarations.
 * Safe to call before the editor mounts — the load is deferred until a
 * Monaco instance exists (CodeEditor flushes via
 * `flushPendingDependencyTypes`).
 */
export async function ensureDependencyTypes(
  runtime: ProjectRuntime,
  packageJsonContent: string,
): Promise<void> {
  const hash = hashPackageJson(packageJsonContent);
  if (hash === loadedHash) return;

  // Templates without a V1 type strategy (Vue/Angular language services
  // are a V2 milestone). Mark done to avoid FS probes.
  const roots = getRootTypePackages(activeTemplate);
  if (!roots) {
    loadedHash = hash;
    pending = null;
    return;
  }

  const monaco = getSharedMonaco();
  if (!monaco || loading) {
    pending = { runtime, packageJsonContent };
    return;
  }

  loading = true;
  try {
    await loadDependencyTypes(monaco, runtime, roots);
    loadedHash = hash;
  } finally {
    loading = false;
  }

  if (pending && hashPackageJson(pending.packageJsonContent) !== loadedHash) {
    const next = pending;
    pending = null;
    await ensureDependencyTypes(next.runtime, next.packageJsonContent);
  } else {
    pending = null;
  }
}

/** Called from CodeEditor onMount. */
export function flushPendingDependencyTypes(): void {
  if (pending && getSharedMonaco()) {
    const next = pending;
    pending = null;
    void ensureDependencyTypes(next.runtime, next.packageJsonContent);
  }
}

export function getLoadedDependencyHash(): string {
  return loadedHash;
}
