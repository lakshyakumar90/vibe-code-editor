import type { VirtualWorkspace } from "@/lib/workspace/workspace";

export interface LoadedProjectTsconfig {
  /** False when no tsconfig.json exists in the workspace (use fallback). */
  found: boolean;
  /** Effective merged compilerOptions (raw JSON values). */
  compilerOptions: Record<string, unknown>;
  /** Workspace-relative tsconfig files that were merged, in order. */
  sourceFiles: string[];
}

/**
 * Phase 2 — the project's own tsconfig is the source of truth.
 * Reads tsconfig.json (+ single-level `extends`, + referenced
 * tsconfig.app.json / tsconfig.node.json) from the browser workspace.
 * Template statics are only a fallback when no tsconfig exists.
 */

function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = "";

  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1] ?? "";

    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

interface RawTsconfig {
  compilerOptions?: Record<string, unknown>;
  extends?: unknown;
  references?: unknown;
}

function parseTsconfig(
  workspace: VirtualWorkspace,
  path: string,
): RawTsconfig | null {
  const raw = workspace.getFile(path);
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as RawTsconfig;
  } catch {
    return null;
  }
}

function resolveRelative(fromFile: string, target: string): string {
  const dir = fromFile.includes("/")
    ? fromFile.slice(0, fromFile.lastIndexOf("/"))
    : "";
  const clean = target.replace(/^\.\//, "");
  return dir ? `${dir}/${clean}` : clean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge order: extends-base < current file < referenced files.
 * (Approximation of TS solution-style projects into Monaco's single
 * program; our templates have at most root + app/node variants.)
 */
export function loadProjectTsconfig(
  workspace: VirtualWorkspace,
): LoadedProjectTsconfig {
  const empty: LoadedProjectTsconfig = {
    found: false,
    compilerOptions: {},
    sourceFiles: [],
  };

  const root = parseTsconfig(workspace, "tsconfig.json");
  if (!root) return empty;

  const merged: Record<string, unknown> = {};
  const sourceFiles = ["tsconfig.json"];

  // Single-level `extends` chain (cap depth to avoid cycles).
  let basePath: unknown = root.extends;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof basePath !== "string") break;
    const resolved = resolveRelative("tsconfig.json", basePath);
    const base = parseTsconfig(workspace, resolved);
    if (!base) break;
    if (isRecord(base.compilerOptions)) {
      Object.assign(merged, base.compilerOptions);
    }
    sourceFiles.unshift(resolved);
    basePath = base.extends;
  }

  if (isRecord(root.compilerOptions)) {
    Object.assign(merged, root.compilerOptions);
  }

  // Referenced project configs (tsconfig.app.json / tsconfig.node.json).
  if (Array.isArray(root.references)) {
    for (const ref of root.references) {
      if (!isRecord(ref) || typeof ref.path !== "string") continue;
      let refFile = ref.path as string;
      if (!refFile.endsWith(".json")) refFile = `${refFile}.json`;
      const resolved = resolveRelative("tsconfig.json", refFile);
      const refConfig = parseTsconfig(workspace, resolved);
      if (refConfig && isRecord(refConfig.compilerOptions)) {
        Object.assign(merged, refConfig.compilerOptions);
        sourceFiles.push(resolved);
      }
    }
  }

  // Next-style alias pattern ("@/*": ["./*"]) without baseUrl resolves
  // against the tsconfig location — synthesize the workspace equivalent
  // so the worker probes file:///project/... model URIs.
  if (merged.paths !== undefined && merged.baseUrl === undefined) {
    merged.baseUrl = "file:///project/";
  }

  return { found: true, compilerOptions: merged, sourceFiles };
}
