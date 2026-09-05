import type * as Monaco from "monaco-editor";
import { hashPackageJson } from "@/lib/webcontainer/dependency-state";
import type { ProjectRuntime } from "@/lib/webcontainer/runtime";
import { workspaceToMonacoUri } from "@/lib/workspace/paths";
import { getSharedMonaco } from "./model-manager";

/**
 * Phase 5 — bridge installed node_modules declarations into Monaco.
 *
 * Roots come from the project's own package.json (dependencies +
 * devDependencies), intersected with what actually exists in the
 * WebContainer — no hardcoded package list. Each package's declaration
 * entry is resolved via types → typings → exports map → main-adjacent
 * .d.ts → index.d.ts, then registered with addExtraLib at
 * file:///project/node_modules/... so the worker's native resolution
 * finds them (relative cross-references between declaration files keep
 * working because original paths are preserved — never flattened into
 * a fake `declare module` string).
 *
 * One transitive level, capped. Full recursive graphs are V2.
 * `skipLibCheck` keeps any remaining gaps from surfacing as errors.
 */

/** Templates with a V1 type strategy (Vue/Angular need Volar/ALS = V2). */
function hasTypeStrategy(template: string): boolean {
  return (
    template === "REACT" ||
    template === "NEXTJS" ||
    template === "EXPRESS" ||
    template === "HONO"
  );
}

/** Max packages to probe per load (roots + one transitive level). */
const MAX_PACKAGES = 25;

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

/** Direct dependency names from a workspace package.json (deps + devDeps). */
export function getPackageRoots(packageJsonContent: string): string[] {
  try {
    const parsed = JSON.parse(packageJsonContent) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const names = new Set<string>();
    for (const section of [parsed.dependencies, parsed.devDependencies]) {
      if (section && typeof section === "object") {
        for (const name of Object.keys(section)) names.add(name);
      }
    }
    return Array.from(names);
  } catch {
    return [];
  }
}

type ExportsField = string | { [key: string]: ExportsField } | string[] | null;

/** Walk an `exports` map by condition priority, collecting .d.ts-ish targets. */
function walkExportsConditions(field: ExportsField, out: string[]): void {
  if (!field) return;
  if (typeof field === "string") {
    out.push(cleanEntry(field));
    return;
  }
  if (Array.isArray(field)) {
    for (const entry of field) walkExportsConditions(entry, out);
    return;
  }
  if (typeof field === "object") {
    // Subpath map (".", "./feature", …) — follow the root entry only.
    if (typeof field["."] === "string" || typeof field["."] === "object") {
      walkExportsConditions(
        field["."] as ExportsField,
        out,
      );
      return;
    }
    for (const condition of [
      "types",
      "typings",
      "default",
      "import",
      "require",
      "node",
    ]) {
      const value = field[condition] as ExportsField | undefined;
      if (typeof value === "string") {
        out.push(cleanEntry(value));
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        walkExportsConditions(value, out);
      }
    }
  }
}

/** `dist/index.js` → `dist/index.d.ts` (main-adjacent declarations). */
function mainToDts(main: string): string | null {
  const clean = cleanEntry(main);
  if (clean.endsWith(".d.ts")) return clean;
  const replaced = clean.replace(/\.(m|c)?js$/, ".d.ts");
  return replaced !== clean ? replaced : null;
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

  let meta: {
    types?: unknown;
    typings?: unknown;
    exports?: unknown;
    main?: unknown;
    dependencies?: unknown;
  };
  try {
    meta = JSON.parse(metaRaw) as {
      types?: unknown;
      typings?: unknown;
      exports?: unknown;
      main?: unknown;
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
  if (meta.exports !== undefined && meta.exports !== null) {
    walkExportsConditions(meta.exports as ExportsField, candidates);
  }
  if (typeof meta.main === "string") {
    const adjacent = mainToDts(meta.main);
    if (adjacent) candidates.push(adjacent);
  }
  candidates.push("index.d.ts");

  const files: ResolvedPackage["files"] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
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
  if (!hasTypeStrategy(activeTemplate)) {
    loadedHash = hash;
    pending = null;
    return;
  }

  // Roots = the project's own direct dependencies (not a static list), so
  // lucide-react / @radix-ui/* / zod load exactly like react does.
  const roots = getPackageRoots(packageJsonContent);
  if (roots.length === 0) {
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
