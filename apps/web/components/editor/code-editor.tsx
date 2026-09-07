"use client";

import { useEffect, useRef, useState } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useTheme } from "next-themes";
import type { ProjectFile } from "@/types/file";
import { getLanguage } from "@/lib/file-icons";
import { fetchCompletion } from "@/lib/ai/completion";
import { readInlineSettings } from "./inline-settings";
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
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "json",
  "css",
  "scss",
  "html",
  "markdown",
  "plaintext",
];

/** Max chars sent as prefix/suffix context. */
const COMPLETION_PREFIX_CHARS = 4000;
const COMPLETION_SUFFIX_CHARS = 2000;
/** Pause after last keystroke before auto-triggered fetch (Explicit/Ctrl+Space skips this). */
const INLINE_DEBOUNCE_MS = 450;
/** Quiet period after a provider 429 before new requests go out. */
const RATE_LIMIT_COOLDOWN_MS = 20_000;
/** Module-level: shared across mounts so keystroke storms can't hammer a limited provider. */
let inlineRateLimitedUntil = 0;

/** localStorage flag enabling the inline-request debug overlay. */
const INLINE_DEBUG_KEY = "inline-debug";

/** Last inline request, rendered in the debug overlay when enabled. */
interface InlineDebugInfo {
  filePath: string;
  language: string;
  line: number;
  column: number;
  prefixTail: string;
  suffixHead: string;
  status: string;
  chars: number;
  ms: number;
  via: string;
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
  const completionProvidersRef = useRef<Array<{ dispose(): void }>>([]);
  const [debugInfo, setDebugInfo] = useState<InlineDebugInfo | null>(null);
  const debugEnabled =
    typeof window !== "undefined" &&
    window.localStorage.getItem(INLINE_DEBUG_KEY) === "1";

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

    // Ghost-text inline completions: direct async provider. Monaco invokes
    // this per pause-in-typing and passes a CancellationToken — the fetch
    // runs for the live position/context and aborts when superseded. No
    // pre-fetch, no cursor-match cache.
    const fetchForPosition = async (
      textModel: Monaco.editor.ITextModel,
      position: Monaco.Position,
      token: Monaco.CancellationToken,
    ): Promise<{ text: string; debug: InlineDebugInfo } | null> => {
      const currentFile = fileRef.current;
      if (!inlineEnabledRef.current || reviewingRef.current) return null;
      if (!currentFile || currentFile.isFolder) return null;
      const started = Date.now();
      const full = textModel.getValue();
      if (full.length > 200_000) return null;
      const offset = textModel.getOffsetAt(position);
      const language = getLanguage(currentFile.name);
      const prefix = full.slice(Math.max(0, offset - COMPLETION_PREFIX_CHARS), offset);
      const suffix = full.slice(offset, offset + COMPLETION_SUFFIX_CHARS);
      const baseDebug = {
        filePath: activePathRef.current ?? currentFile.path,
        language,
        line: position.lineNumber,
        column: position.column,
        prefixTail: prefix.slice(-160),
        suffixHead: suffix.slice(0, 120),
        chars: 0,
        ms: 0,
      };
      // 429 breaker: while cooling down, don't even send requests.
      if (Date.now() < inlineRateLimitedUntil) {
        const debug = {
          ...baseDebug,
          status: `cooldown (${Math.ceil((inlineRateLimitedUntil - Date.now()) / 1000)}s)`,
          ms: 0,
          via: "—",
        };
        setDebugInfo(debug);
        return null;
      }
      // Phase E: inline provider/model from settings (independent of chat).
      const inline = readInlineSettings();
      let via = `${inline.provider}/${inline.model}`;
      console.debug("[inline]", { ...baseDebug, via });
      const aborter = new AbortController();
      const cancelListener = token.onCancellationRequested(() => aborter.abort());
      // Falls back to the server default chain when the configured
      // provider isn't set up (e.g. missing key) instead of going dark.
      const attempt = (provider?: string, model?: string) =>
        fetchCompletion({
          projectId: projectIdRef.current,
          filePath: activePathRef.current ?? currentFile.path,
          language,
          cursor: { line: position.lineNumber, column: position.column, offset },
          prefix,
          suffix,
          signal: aborter.signal,
          ...(provider ? { provider, model } : {}),
        });
      const notConfigured = (err: unknown) =>
        err instanceof Error &&
        (/not configured/i.test(err.message) ||
          (err as Error & { code?: unknown }).code === "PROVIDER_NOT_CONFIGURED");
      try {
        let text: string;
        try {
          text = await attempt(inline.provider, inline.model);
        } catch (err) {
          if (!notConfigured(err) || aborter.signal.aborted) throw err;
          text = await attempt();
          via = "server-default";
        }
        const ms = Date.now() - started;
        if (!text.trim()) {
          const debug = { ...baseDebug, status: "empty", ms, via };
          setDebugInfo(debug);
          console.debug("[inline] empty", { ms, via });
          return null;
        }
        const debug = { ...baseDebug, status: "ok", chars: text.length, ms, via };
        setDebugInfo(debug);
        console.debug("[inline] ok", { chars: text.length, ms, via });
        return { text, debug };
      } catch (err) {
        const ms = Date.now() - started;
        const aborted = aborter.signal.aborted;
        const rateLimited =
          !aborted &&
          err instanceof Error &&
          ((err as Error & { code?: unknown }).code === "PROVIDER_RATE_LIMITED" ||
            /\(429\)|rate.?limit/i.test(err.message));
        if (rateLimited) {
          inlineRateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        }
        const status = aborted
          ? "aborted"
          : rateLimited
            ? "rate-limited, cooling down"
            : `error: ${err instanceof Error ? err.message : "unknown"}`;
        const debug = { ...baseDebug, status, ms, via };
        setDebugInfo(debug);
        console.debug("[inline] failed", debug);
        return null;
      } finally {
        cancelListener.dispose();
      }
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
    for (const language of COMPLETION_LANGUAGES) {
      try {
        completionProvidersRef.current.push(
          monaco.languages.registerInlineCompletionsProvider(language, {
            async provideInlineCompletions(
              textModel: Monaco.editor.ITextModel,
              position: Monaco.Position,
              context: Monaco.languages.InlineCompletionContext,
              token: Monaco.CancellationToken,
            ) {
              if (!inlineEnabledRef.current || reviewingRef.current) {
                return { items: [] };
              }
              // Collapse keystroke storms: auto-triggered invocations wait
              // for a typing pause (superseded ones exit during the wait and
              // never hit the network — this is what "cancelled" was).
              // Explicit invocations (Ctrl+Space) fetch immediately.
              const explicitKind =
                monaco.languages.InlineCompletionTriggerKind?.Explicit ?? 1;
              if (context.triggerKind !== explicitKind) {
                const paused = await new Promise<boolean>((resolve) => {
                  const timer = setTimeout(() => resolve(true), INLINE_DEBOUNCE_MS);
                  token.onCancellationRequested(() => {
                    clearTimeout(timer);
                    resolve(false);
                  });
                });
                if (!paused || token.isCancellationRequested) {
                  return { items: [] };
                }
              }
              const result = await fetchForPosition(textModel, position, token);
              if (!result || token.isCancellationRequested) {
                return { items: [] };
              }
              return {
                items: [
                  {
                    insertText: result.text,
                    range: new monaco.Range(
                      position.lineNumber,
                      position.column,
                      position.lineNumber,
                      position.column,
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

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
      editor.trigger("ai.complete", "editor.action.inlineSuggest.trigger", null);
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
      <div className="relative min-h-0 flex-1">
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
        {debugEnabled && debugInfo && (
          <details
            open
            className="absolute bottom-2 right-2 z-10 max-w-[420px] rounded-md border bg-popover/95 p-2 text-[11px] shadow-md backdrop-blur"
          >
            <summary className="cursor-pointer font-medium">
              inline: {debugInfo.status} ({debugInfo.ms}ms via {debugInfo.via})
            </summary>
            <div className="mt-1 space-y-1 font-mono leading-relaxed text-muted-foreground">
              <div>
                {debugInfo.filePath} · {debugInfo.language} · {debugInfo.line}:{debugInfo.column}
                {debugInfo.chars > 0 && ` · +${debugInfo.chars} chars`}
              </div>
              <div className="whitespace-pre-wrap break-all border-t pt-1">
                …{debugInfo.prefixTail}▌{debugInfo.suffixHead}…
              </div>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
