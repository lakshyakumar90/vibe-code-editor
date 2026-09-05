import type * as Monaco from "monaco-editor";

export type LanguageTemplate = "REACT" | "HONO" | "EXPRESS" | "NEXTJS";

type CompilerOptions = Monaco.typescript.CompilerOptions;

/**
 * Step 5 — per-template TypeScript compiler options for Monaco's TS worker.
 * Mirrors the seeded template tsconfig semantics. Takes the monaco instance
 * so enum values are always correct (no magic numbers).
 *
 * VUE / ANGULAR intentionally return null: they need Volar / Angular
 * Language Service (V2 milestone). Callers fall back to basic TS.
 */
export function getCompilerOptions(
  monaco: typeof Monaco,
  template: string,
): CompilerOptions | null {
  // NOTE: monaco-editor >= 0.52 moved TS tooling from
  // `monaco.languages.typescript` (deprecated stub) to top-level
  // `monaco.typescript`.
  const ts = monaco.typescript;

  // Ceiling note: monaco-editor 0.56's bundled TS worker only exposes
  // ScriptTarget up to ES2020 and ModuleResolutionKind Classic/NodeJs
  // (no Bundler/Node16). NodeJs covers relative imports, index files,
  // node_modules and @types — enough for V1. Bundler semantics
  // (exports-field) need a newer TS worker (V2 milestone).
  const base: CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowJs: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };

  switch (template as LanguageTemplate) {
    case "REACT":
    case "NEXTJS":
      return { ...base, jsx: ts.JsxEmit.ReactJSX };
    case "HONO":
    case "EXPRESS":
      return {
        ...base,
        jsx: ts.JsxEmit.None,
        types: ["node"],
      };
    default:
      return null;
  }
}
