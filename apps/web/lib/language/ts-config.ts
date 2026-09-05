import type * as Monaco from "monaco-editor";

export type LanguageTemplate = "REACT" | "HONO" | "EXPRESS" | "NEXTJS";

type CompilerOptions = Monaco.typescript.CompilerOptions;
type RawOptions = Record<string, unknown>;

/** Raw compilerOptions as parsed from a tsconfig (JSON values). */
export type RawCompilerOptions = Record<string, unknown>;

// NOTE: monaco-editor >= 0.52 moved TS tooling from
// `monaco.languages.typescript` (deprecated stub) to top-level
// `monaco.typescript`.

/**
 * Numeric escapes for values the register enums don't expose.
 * Bundled TS is 5.9.3 (full bundler/exports/jsxImportSource support);
 * only the d.ts register enums lag (ScriptTarget <= ES2020,
 * ModuleResolutionKind Classic/NodeJs only). Values below are stable
 * across TS 5.x and flow straight into ts.createLanguageService.
 */
const TARGET_NUMERIC: Record<string, number> = {
  es2021: 8,
  es2022: 9,
  esnext: 99,
  latest: 99,
};

const MODULE_NUMERIC: Record<string, number> = {
  node16: 100,
  nodenext: 199,
};

const RESOLUTION_NUMERIC: Record<string, number> = {
  node16: 3,
  nodenext: 99,
  bundler: 100,
};

function jsxMap(monaco: typeof Monaco): Record<string, number> {
  const emit = monaco.typescript.JsxEmit;
  return {
    none: emit.None,
    preserve: emit.Preserve,
    react: emit.React,
    "react-native": emit.ReactNative,
    "react-jsx": emit.ReactJSX,
    "react-jsxdev": emit.ReactJSXDev,
  };
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

function enumValue(
  enumObj: Record<string, string | number>,
  key: string,
): number | undefined {
  const normalized = key.replace(/-/g, "").toLowerCase();
  for (const [name, val] of Object.entries(enumObj)) {
    if (typeof val === "number" && name.toLowerCase() === normalized) {
      return val;
    }
  }
  return undefined;
}

/**
 * Phase 2 — project-driven compiler options.
 * Starts from the template fallback, then overlays every supported field
 * the project's own tsconfig provides. Template values survive only for
 * fields the project genuinely omits.
 *
 * VUE / ANGULAR return null: they need Volar / Angular Language Service
 * (V2 milestone). Callers fall back to basic TS.
 */
export function buildCompilerOptions(
  monaco: typeof Monaco,
  project: RawOptions,
  template: string,
): CompilerOptions | null {
  const ts = monaco.typescript;

  switch (template as LanguageTemplate) {
    case "REACT":
    case "NEXTJS":
    case "HONO":
    case "EXPRESS":
      break;
    default:
      return null;
  }

  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const templateIsNode = template === "HONO" || template === "EXPRESS";

  const targetKey = str(project.target)?.toLowerCase();
  const target =
    (targetKey
      ? (enumValue(
          ts.ScriptTarget as unknown as Record<string, string | number>,
          targetKey,
        ) ?? TARGET_NUMERIC[targetKey])
      : undefined) ?? ts.ScriptTarget.ES2020;

  const moduleKey = str(project.module)?.toLowerCase();
  const moduleKind =
    (moduleKey
      ? (enumValue(
          ts.ModuleKind as unknown as Record<string, string | number>,
          moduleKey,
        ) ?? MODULE_NUMERIC[moduleKey])
      : undefined) ?? ts.ModuleKind.ESNext;

  const resolutionKey = str(project.moduleResolution)?.toLowerCase();
  const moduleResolution =
    (resolutionKey
      ? (enumValue(
          ts.ModuleResolutionKind as unknown as Record<string, string | number>,
          resolutionKey,
        ) ?? RESOLUTION_NUMERIC[resolutionKey])
      : undefined) ?? ts.ModuleResolutionKind.NodeJs;

  const jsxKey = str(project.jsx)?.toLowerCase();
  const jsx =
    (jsxKey ? jsxMap(monaco)[jsxKey] : undefined) ??
    (template === "REACT" || template === "NEXTJS"
      ? ts.JsxEmit.ReactJSX
      : ts.JsxEmit.None);

  const out: RawOptions = {
    target,
    module: moduleKind,
    moduleResolution,
    jsx,
    allowJs: asBool(project.allowJs) ?? true,
    checkJs: asBool(project.checkJs) ?? false,
    allowSyntheticDefaultImports:
      asBool(project.allowSyntheticDefaultImports) ?? true,
    esModuleInterop: asBool(project.esModuleInterop) ?? true,
    strict: asBool(project.strict) ?? true,
    skipLibCheck: asBool(project.skipLibCheck) ?? true,
    noEmit: asBool(project.noEmit) ?? true,
    resolveJsonModule: asBool(project.resolveJsonModule) ?? false,
  };

  const baseUrl = str(project.baseUrl);
  if (baseUrl) out.baseUrl = baseUrl;

  if (
    project.paths !== undefined &&
    typeof project.paths === "object" &&
    project.paths !== null
  ) {
    const paths: Record<string, string[]> = {};
    for (const [alias, targets] of Object.entries(
      project.paths as Record<string, unknown>,
    )) {
      const arr = asStringArray(targets);
      if (arr) paths[alias] = arr;
    }
    if (Object.keys(paths).length > 0) out.paths = paths;
  }

  // jsxImportSource exists in TS 5.9 but not in the register d.ts —
  // attach untyped (Hono's `hono/jsx` depends on it).
  const jsxImportSource = str(project.jsxImportSource);
  if (jsxImportSource) out.jsxImportSource = jsxImportSource;

  const types = asStringArray(project.types);
  if (types) {
    out.types = types;
  } else if (templateIsNode) {
    out.types = ["node"];
  }

  const typeRoots = asStringArray(project.typeRoots);
  if (typeRoots) out.typeRoots = typeRoots;

  const lib = asStringArray(project.lib);
  if (lib) out.lib = lib;

  return out as unknown as CompilerOptions;
}

/**
 * Template-only fallback, used when no tsconfig.json exists in the
 * workspace. Prefer buildCompilerOptions with loader output.
 */
export function getCompilerOptions(
  monaco: typeof Monaco,
  template: string,
): CompilerOptions | null {
  return buildCompilerOptions(monaco, {}, template);
}
