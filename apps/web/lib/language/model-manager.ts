import type * as Monaco from "monaco-editor";
import { workspaceToMonacoUri } from "@/lib/workspace/paths";
import { getCompilerOptions } from "./ts-config";

type MonacoInstance = typeof Monaco;

let languageInitialized = false;
let sharedMonaco: MonacoInstance | null = null;

/** Latest mounted Monaco instance (set by CodeEditor onMount). */
export function setSharedMonaco(monaco: MonacoInstance): void {
  sharedMonaco = monaco;
}

export function getSharedMonaco(): MonacoInstance | null {
  return sharedMonaco;
}

/**
 * Step 6 — one-time TypeScript worker configuration.
 * Safe to call from every onMount; only the first call applies.
 */
export function initLanguage(
  monaco: MonacoInstance,
  template = "REACT",
): void {
  if (languageInitialized) return;
  languageInitialized = true;

  const ts = monaco.typescript;
  const options = getCompilerOptions(monaco, template);

  if (options) {
    ts.typescriptDefaults.setCompilerOptions(options);
  } else {
    console.warn(
      `[language] no compiler config for template "${template}" — basic TS only`,
    );
  }

  ts.typescriptDefaults.setEagerModelSync(true);
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
  });
}

/**
 * Step 6 — persistent `path -> model` registry.
 * Models are keyed by stable URI (file:///project/...) and NEVER
 * recreated on tab switch — this is what lets the TS worker resolve
 * cross-file imports natively.
 */
export function ensureModel(
  monaco: MonacoInstance,
  dbPath: string,
  content: string,
  language: string,
): Monaco.editor.ITextModel {
  const uri = monaco.Uri.parse(workspaceToMonacoUri(dbPath));
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== content) {
      existing.setValue(content);
    }
    return existing;
  }
  return monaco.editor.createModel(content, language, uri);
}

export function getModel(
  monaco: MonacoInstance,
  dbPath: string,
): Monaco.editor.ITextModel | undefined {
  return (
    monaco.editor.getModel(monaco.Uri.parse(workspaceToMonacoUri(dbPath))) ??
    undefined
  );
}

export function removeModel(monaco: MonacoInstance, dbPath: string): void {
  getModel(monaco, dbPath)?.dispose();
}

/** Dispose a model via the shared instance (no-op if editor never mounted). */
export function removeModelByPath(dbPath: string): void {
  if (sharedMonaco) removeModel(sharedMonaco, dbPath);
}
