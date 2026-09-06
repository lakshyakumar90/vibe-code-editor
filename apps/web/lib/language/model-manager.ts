import type * as Monaco from "monaco-editor";
import { workspaceToMonacoUri } from "@/lib/workspace/paths";

type MonacoInstance = typeof Monaco;

let sharedMonaco: MonacoInstance | null = null;
let sharedEditor: Monaco.editor.IStandaloneCodeEditor | null = null;
let languageInitialized = false;

/** Latest mounted Monaco instance (set by CodeEditor onMount). */
export function setSharedMonaco(monaco: MonacoInstance): void {
  sharedMonaco = monaco;
}

export function getSharedMonaco(): MonacoInstance | null {
  return sharedMonaco;
}

/** Active editor instance (set by CodeEditor onMount). */
export function setSharedEditor(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
): void {
  sharedEditor = editor;
}

export function getSharedEditor(): Monaco.editor.IStandaloneCodeEditor | null {
  return sharedEditor;
}

function getTs(monaco: MonacoInstance) {
  const m = monaco as unknown as Record<string, unknown>;
  const languages = m?.languages as Record<string, unknown> | undefined;
  return (languages?.typescript ?? m?.typescript) as
    | typeof Monaco.typescript
    | undefined;
}

/**
 * Bolt-style language setup: syntax highlighting + brackets + basic
 * completion only. No diagnostics, no cross-file intelligence.
 *
 * - Disables TS/JS semantic + syntax validation (no red squiggles).
 * - Applies a minimal compiler config so the default TS worker has
 *   nothing to resolve against (no go-to-definition targets).
 * - Suppresses Ctrl/Cmd+Click navigation via a no-op editor opener.
 */
export function initLanguage(monaco: MonacoInstance): void {
  if (languageInitialized) return;
  languageInitialized = true;

  const ts = getTs(monaco);
  if (ts) {
    try {
      ts.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: true,
        noSuggestionDiagnostics: true,
      });
    } catch {
      // best-effort
    }
    try {
      ts.javascriptDefaults?.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: true,
        noSuggestionDiagnostics: true,
      });
    } catch {
      // best-effort
    }
    // Minimal compiler options: no resolution, no lib graph.
    try {
      const minimal = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        noLib: true,
        allowJs: true,
        checkJs: false,
        noResolve: true,
      } as unknown as Monaco.typescript.CompilerOptions;
      ts.typescriptDefaults.setCompilerOptions(minimal);
      try {
        ts.javascriptDefaults?.setCompilerOptions(minimal);
      } catch {
        // best-effort
      }
    } catch {
      // best-effort
    }
    try {
      ts.typescriptDefaults.setEagerModelSync(false);
      ts.javascriptDefaults?.setEagerModelSync(false);
    } catch {
      // best-effort
    }
  }

  // No-op the editor opener so Ctrl/Cmd+Click has nowhere to go.
  try {
    monaco.editor.registerEditorOpener({
      openCodeEditor: () => false,
    });
  } catch {
    // best-effort (already registered in some versions)
  }
}

/**
 * One model per OPEN file. Created on open, disposed on close.
 * No background warm-up, no project-graph preload.
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

// --- Removed cross-file intelligence: kept as no-op stubs so existing
// callers compile while the pipeline is ripped out. Do not revive. ---

export interface PreloadFile {
  path: string;
  content: string | null;
  language: string;
}

export const MAX_PRELOAD_MODELS = 0;
export const MAX_PRELOAD_BYTES = 0;

export interface LanguageSnapshot {
  models: number;
  modelSample: string[];
  options: {
    target: unknown;
    module: unknown;
    moduleResolution: unknown;
    jsx: unknown;
    baseUrl: unknown;
    paths: string[];
  };
  extraLibs: number;
  probes: Record<string, boolean>;
}

export function getLanguageSnapshot(): LanguageSnapshot | null {
  return null;
}

/** No-op: problems panel removed, kept for jump-to-location compat. */
export function revealInEditor(
  _dbPath: string,
  _lineNumber: number,
  _column: number,
): void {}

export function reconfigureLanguage(): void {}

export function ensureAllModels(): number {
  return 0;
}

export function requestPreload(): void {}

export function flushPendingPreload(): void {}

export function requestLanguageSetup(): number {
  return 0;
}

export function flushPendingLanguageSetup(): void {}
