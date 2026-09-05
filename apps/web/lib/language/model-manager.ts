import type * as Monaco from "monaco-editor";
import { workspaceToMonacoUri } from "@/lib/workspace/paths";
import {
  buildCompilerOptions,
  getCompilerOptions,
  type RawCompilerOptions,
} from "./ts-config";

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

let sharedEditor: Monaco.editor.IStandaloneCodeEditor | null = null;

/** Active editor instance (set by CodeEditor onMount). */
export function setSharedEditor(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
): void {
  sharedEditor = editor;
}

export function getSharedEditor(): Monaco.editor.IStandaloneCodeEditor | null {
  return sharedEditor;
}

/**
 * Focus the editor on a file + position (used by the Problems panel).
 * No-op if the model isn't materialized yet.
 */
export function revealInEditor(
  dbPath: string,
  lineNumber: number,
  column: number,
): void {
  if (!sharedMonaco || !sharedEditor) return;
  const model = getModel(sharedMonaco, dbPath);
  if (!model) return;
  if (sharedEditor.getModel() !== model) {
    sharedEditor.setModel(model);
  }
  sharedEditor.revealPositionInCenter({ lineNumber, column });
  sharedEditor.setPosition({ lineNumber, column });
  sharedEditor.focus();
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

  applyBaseLanguageConfig(monaco);
}

function applyBaseLanguageConfig(monaco: MonacoInstance): void {
  const ts = monaco.typescript;
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
  });
}

/**
 * Phase 7 — project-aware reconfiguration. The single authoritative
 * setCompilerOptions path alongside initLanguage; call only on project
 * switch or tsconfig change, never per render.
 */
export function reconfigureLanguage(
  monaco: MonacoInstance,
  options: Monaco.typescript.CompilerOptions | null,
  template = "REACT",
): void {
  languageInitialized = true;
  const ts = monaco.typescript;
  const effective = options ?? getCompilerOptions(monaco, template);
  if (effective) {
    ts.typescriptDefaults.setCompilerOptions(effective);
  } else {
    console.warn(
      `[language] no compiler config for template "${template}" — basic TS only`,
    );
  }
  applyBaseLanguageConfig(monaco);
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

export interface PreloadFile {
  path: string;
  content: string | null;
  language: string;
}

/** Bounds for project-wide preload (user projects can grow large). */
export const MAX_PRELOAD_MODELS = 500;
export const MAX_PRELOAD_BYTES = 500_000;

let pendingPreload: (() => PreloadFile[]) | null = null;

interface PendingLanguageSetup {
  options: RawCompilerOptions;
  template: string;
  files: () => PreloadFile[];
}

let pendingSetup: PendingLanguageSetup | null = null;

/**
 * Phase 1 — materialize one persistent model per project file so the
 * language service sees the whole graph without requiring files to be
 * opened. Idempotent (duplicate URIs reused), per-file failures isolated.
 * Returns the number of models ensured.
 */
export function ensureAllModels(
  monaco: MonacoInstance,
  files: PreloadFile[],
): number {
  let count = 0;
  for (const file of files ?? []) {
    if (count >= MAX_PRELOAD_MODELS) break;
    const content = file.content ?? "";
    if (content.length > MAX_PRELOAD_BYTES) continue;
    try {
      ensureModel(monaco, file.path, content, file.language);
      count++;
    } catch {
      // One bad file must not break the project graph.
    }
  }
  return count;
}

/**
 * Defer preload until a Monaco instance exists (CodeEditor flushes via
 * flushPendingPreload on mount). The supplier is re-read at flush time
 * so content is never stale.
 */
export function requestPreload(supplier: () => PreloadFile[]): void {
  const monaco = sharedMonaco;
  if (monaco) {
    ensureAllModels(monaco, supplier());
    return;
  }
  pendingPreload = supplier;
}

/** Called from CodeEditor onMount. */
export function flushPendingPreload(): void {
  if (pendingPreload && sharedMonaco) {
    const supplier = pendingPreload;
    pendingPreload = null;
    ensureAllModels(sharedMonaco, supplier());
  }
}

/**
 * Combined project setup: compiler options from the project tsconfig +
 * full model preload. Applies immediately when Monaco exists, otherwise
 * defers everything to CodeEditor mount (flushPendingLanguageSetup).
 * This is the single driver for Phase 1 + Phase 2.
 */
export function requestLanguageSetup(
  options: RawCompilerOptions,
  template: string,
  files: () => PreloadFile[],
): void {
  const monaco = sharedMonaco;
  if (monaco) {
    reconfigureLanguage(
      monaco,
      buildCompilerOptions(monaco, options, template),
      template,
    );
    ensureAllModels(monaco, files());
    return;
  }
  pendingPreload = files;
  pendingSetup = { options, template, files };
}

/** Called from CodeEditor onMount, before dependency-type flush. */
export function flushPendingLanguageSetup(): void {
  if (pendingSetup && sharedMonaco) {
    const setup = pendingSetup;
    pendingSetup = null;
    pendingPreload = null;
    reconfigureLanguage(
      sharedMonaco,
      buildCompilerOptions(sharedMonaco, setup.options, setup.template),
      setup.template,
    );
    ensureAllModels(sharedMonaco, setup.files());
    return;
  }
  flushPendingPreload();
}
