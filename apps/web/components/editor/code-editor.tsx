"use client";

import { useEffect, useRef } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useTheme } from "next-themes";
import type { ProjectFile } from "@/types/file";
import { getLanguage } from "@/lib/file-icons";
import { fetchCompletion } from "@/lib/ai/completion";
import {
  ensureModel,
  removeModelByPath,
  initLanguage,
  setSharedEditor,
  setSharedMonaco,
} from "@/lib/language/model-manager";

/** Languages with ghost-text providers registered (see handleMount). */
const COMPLETION_LANGUAGES = [
  "typescript",
  "javascript",
  "json",
  "css",
  "scss",
  "html",
  "markdown",
  "plaintext",
];

/** Debounce before requesting a completion after typing stops. */
const COMPLETION_DEBOUNCE_MS = 700;
/** Max chars sent as prefix/suffix context. */
const COMPLETION_PREFIX_CHARS = 4000;
const COMPLETION_SUFFIX_CHARS = 2000;

interface CachedCompletion {
  line: number;
  column: number;
  text: string;
}

export interface AskAISelection {
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
}

/** Pending agent diff for the open file (Phase 4 review, read-only). */
export interface ReviewDiff {
  oldContent: string | null;
  newContent: string | null;
}

interface CodeEditorProps {
  projectId: string;
  file: ProjectFile | null;
  value: string;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  saving: boolean;
  /** Ask-AI selection action (right-click menu when text is selected). */
  onAskAI?: (selection: AskAISelection) => void;
  /** When set, renders a read-only inline diff instead of the editor. */
  reviewDiff?: ReviewDiff | null;
  /** Ghost-text inline completions (default on). */
  inlineEnabled?: boolean;
}

export function CodeEditor({
  projectId,
  file,
  value,
  onChange,
  onSave,
  saving: _saving,
  onAskAI,
  reviewDiff,
  inlineEnabled = true,
}: CodeEditorProps) {
  void _saving;
  const onAskAIRef = useRef(onAskAI);
  onAskAIRef.current = onAskAI;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const fileRef = useRef(file);
  fileRef.current = file;
  const inlineEnabledRef = useRef(inlineEnabled);
  inlineEnabledRef.current = inlineEnabled;
  const completionCacheRef = useRef<CachedCompletion | null>(null);
  const completionAbortRef = useRef<AbortController | null>(null);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionProvidersRef = useRef<Array<{ dispose(): void }>>([]);
  const completionListenerRef = useRef<{ dispose(): void } | null>(null);

  const editorRef =
    useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const activePathRef = useRef<string | null>(null);

  // global Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void onSaveRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    setSharedMonaco(monaco);
    setSharedEditor(editor);
    // Strip-down: no diagnostics, no type graph, no definition provider.
    initLanguage(monaco);
    if (file) {
      activePathRef.current = file.path;
      editor.setModel(
        ensureModel(monaco, file.path, value, getLanguage(file.name)),
      );
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void onSaveRef.current();
    });
    // Ask-AI selection entry (right-click menu, only with a selection).
    editor.addAction({
      id: "ask-ai",
      label: "Ask AI",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.5,
      precondition: "editorHasSelection",
      run: (ed) => {
        const cb = onAskAIRef.current;
        const model = ed.getModel();
        const selection = ed.getSelection();
        if (!cb || !model || !selection || selection.isEmpty()) return;
        const path = activePathRef.current;
        if (!path) return;
        cb({
          filePath: path,
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber,
          code: model.getValueInRange(selection),
        });
      },
    });

    // Ghost-text inline completions: fetch debounced, render natively.
    const requestCompletion = () => {
      if (!inlineEnabledRef.current || reviewingRef.current) return;
      const ed = editorRef.current;
      const currentFile = fileRef.current;
      if (!ed || !currentFile || currentFile.isFolder) return;
      const model = ed.getModel();
      const position = ed.getPosition();
      if (!model || !position) return;
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      completionAbortRef.current?.abort();
      const line = position.lineNumber;
      const column = position.column;
      completionTimerRef.current = setTimeout(() => {
        void (async () => {
          try {
            const full = model.getValue();
            if (full.length > 200_000) return;
            const offset = model.getOffsetAt({ lineNumber: line, column });
            // Skip if the cursor moved on while waiting.
            const now = ed.getPosition();
            if (!now || now.lineNumber !== line || now.column !== column) return;
            const aborter = new AbortController();
            completionAbortRef.current = aborter;
            const text = await fetchCompletion({
              projectId: projectIdRef.current,
              filePath: activePathRef.current ?? currentFile.path,
              language: getLanguage(currentFile.name),
              cursor: { line, column, offset },
              prefix: full.slice(Math.max(0, offset - COMPLETION_PREFIX_CHARS), offset),
              suffix: full.slice(offset, offset + COMPLETION_SUFFIX_CHARS),
              signal: aborter.signal,
            });
            if (!text.trim()) {
              completionCacheRef.current = null;
              return;
            }
            completionCacheRef.current = { line, column, text };
            ed.trigger("ai.complete", "editor.action.inlineSuggest.trigger", null);
          } catch {
            // Aborts and backend errors silently clear the pending suggestion.
            completionCacheRef.current = null;
          }
        })();
      }, COMPLETION_DEBOUNCE_MS);
    };

    // Dispose stale providers (Editor remounts around DiffEditor review).
    for (const d of completionProvidersRef.current) {
      try {
        d.dispose();
      } catch {
        // already disposed
      }
    }
    completionProvidersRef.current = [];
    completionCacheRef.current = null;
    for (const language of COMPLETION_LANGUAGES) {
      try {
        completionProvidersRef.current.push(
          monaco.languages.registerInlineCompletionsProvider(language, {
            provideInlineCompletions(
              model: Monaco.editor.ITextModel,
              position: Monaco.Position,
            ) {
              void model;
              const cached = completionCacheRef.current;
              if (
                !inlineEnabledRef.current ||
                !cached ||
                cached.line !== position.lineNumber ||
                cached.column !== position.column
              ) {
                return { items: [] };
              }
              return {
                items: [
                  {
                    insertText: cached.text,
                    range: new monaco.Range(
                      cached.line,
                      cached.column,
                      cached.line,
                      cached.column,
                    ),
                  },
                ],
              };
            },
            freeInlineCompletions() {},
          }),
        );
      } catch {
        // language already registered or unsupported — skip
      }
    }

    try {
      completionListenerRef.current?.dispose();
    } catch {
      // already disposed
    }
    completionListenerRef.current = editor.onDidChangeModelContent(() => {
      completionCacheRef.current = null;
      requestCompletion();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
      completionCacheRef.current = null;
      requestCompletion();
    });
    editor.focus();
  };

  // While a pending diff is shown, the inner Editor is unmounted (a
  // DiffEditor renders instead) — editorRef is stale, so skip model sync.
  const reviewingRef = useRef(false);
  reviewingRef.current = !!reviewDiff;

  // Tab switch: swap to the open file's model (created on open).
  // The layout disposes a file's model when its tab closes.
  useEffect(() => {
    if (reviewingRef.current) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !file) return;
    if (activePathRef.current !== file.path) {
      activePathRef.current = file.path;
      editor.setModel(
        ensureModel(monaco, file.path, value, getLanguage(file.name)),
      );
    } else {
      const model = editor.getModel();
      if (model && model.getValue() !== value) {
        model.setValue(value);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path]);

  // External value sync (e.g. post-save refresh).
  useEffect(() => {
    if (reviewingRef.current) return;
    const model = editorRef.current?.getModel();
    if (
      model &&
      file &&
      activePathRef.current === file.path &&
      model.getValue() !== value
    ) {
      model.setValue(value);
    }
  }, [value, file]);

  // Dispose this file's model when its tab closes (unmount on path change).
  const filePath = file?.path;
  useEffect(() => {
    return () => {
      if (filePath) removeModelByPath(filePath);
    };
  }, [filePath]);

  // Dispose completion plumbing once on full unmount (NOT on tab switch —
  // the Editor instance and its providers persist across tabs).
  useEffect(() => {
    return () => {
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      completionAbortRef.current?.abort();
      try {
        completionListenerRef.current?.dispose();
      } catch {
        // already disposed
      }
      for (const d of completionProvidersRef.current) {
        try {
          d.dispose();
        } catch {
          // already disposed
        }
      }
      completionProvidersRef.current = [];
    };
  }, []);

  const { resolvedTheme } = useTheme();
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "vs";

  if (!file) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file to begin editing.</div>;
  }

  // Pending agent diff: read-only inline diff (original = current DB
  // content, modified = proposed). Uses anonymous models — the live
  // per-path model is untouched until Accept.
  if (reviewDiff) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <DiffEditor
            height="100%"
            theme={monacoTheme}
            language={getLanguage(file.name)}
            original={reviewDiff.oldContent ?? ""}
            modified={reviewDiff.newContent ?? ""}
            options={{
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 14,
              readOnly: true,
              renderSideBySide: false,
              scrollBeyondLastLine: false,
              wordWrap: "on",
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          theme={monacoTheme}
          onChange={(nextValue) => {
            onChange(nextValue ?? "");
          }}
          onMount={handleMount}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            tabSize: 2,
            wordWrap: "on",
            scrollBeyondLastLine: false,
            // Bolt-style: no navigation affordances.
            links: false,
            gotoLocation: {
              multiple: "goto",
              multipleDefinitions: "goto",
              multipleTypeDefinitions: "goto",
              multipleDeclarations: "goto",
              multipleImplementations: "goto",
              multipleReferences: "goto",
              alternativeDefinitionCommand: "",
              alternativeTypeDefinitionCommand: "",
              alternativeDeclarationCommand: "",
              alternativeImplementationCommand: "",
              alternativeReferenceCommand: "",
            },
            definitionLinkOpensInPeek: false,
            hover: { enabled: "off" },
            parameterHints: { enabled: false },
            suggestOnTriggerCharacters: false,
            quickSuggestions: {
              other: true,
              comments: false,
              strings: false,
            },
            codeLens: false,
          }}
        />
      </div>
    </div>
  );
}
