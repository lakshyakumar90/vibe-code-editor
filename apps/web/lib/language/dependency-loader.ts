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
 * V1 scope: react, react-dom, @types/react, @types/react-dom (+ react
 * jsx runtimes). Transitive dep-of-dep types (e.g. csstype) are a follow-up.
 * `skipLibCheck` (see ts-config) keeps missing transitive refs from
 * surfacing as errors.
 */

const CORE_PKGS = ["react", "react-dom", "@types/react", "@types/react-dom"];

interface PendingLoad {
  runtime: ProjectRuntime;
  packageJsonContent: string;
}

let loadedHash = "";
let loading = false;
let pending: PendingLoad | null = null;
let extraLibs: Array<{ dispose(): void }> = [];

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

/** Main declaration file(s) for one installed package. */
async function resolveDeclarationFiles(
  runtime: ProjectRuntime,
  pkg: string,
): Promise<Array<{ monacoPath: string; content: string }>> {
  const metaRaw = await readContainerText(
    runtime,
    `/node_modules/${pkg}/package.json`,
  );
  if (!metaRaw) return [];

  let meta: { types?: unknown; typings?: unknown };
  try {
    meta = JSON.parse(metaRaw) as { types?: unknown; typings?: unknown };
  } catch {
    return [];
  }

  const candidates: string[] = [];
  if (typeof meta.types === "string") candidates.push(cleanEntry(meta.types));
  if (typeof meta.typings === "string" && meta.typings !== meta.types) {
    candidates.push(cleanEntry(meta.typings));
  }
  candidates.push("index.d.ts");

  const out: Array<{ monacoPath: string; content: string }> = [];
  for (const candidate of candidates) {
    const content = await readContainerText(
      runtime,
      `/node_modules/${pkg}/${candidate}`,
    );
    if (content !== null) {
      out.push({
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
        out.push({
          monacoPath: workspaceToMonacoUri(`node_modules/react/${extra}`),
          content,
        });
      }
    }
  }

  return out;
}

async function loadDependencyTypes(
  monaco: typeof Monaco,
  runtime: ProjectRuntime,
): Promise<number> {
  for (const lib of extraLibs) {
    try {
      lib.dispose();
    } catch {
      // ignore stale disposables
    }
  }
  extraLibs = [];

  let count = 0;
  for (const pkg of CORE_PKGS) {
    const files = await resolveDeclarationFiles(runtime, pkg);
    for (const file of files) {
      extraLibs.push(
        monaco.typescript.typescriptDefaults.addExtraLib(
          file.content,
          file.monacoPath,
        ),
      );
      count++;
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

  const monaco = getSharedMonaco();
  if (!monaco || loading) {
    pending = { runtime, packageJsonContent };
    return;
  }

  loading = true;
  try {
    await loadDependencyTypes(monaco, runtime);
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
