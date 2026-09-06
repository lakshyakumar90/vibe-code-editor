"use client";

import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import type { ProjectFile } from "@/types/file";
import { getLanguage } from "@/lib/file-icons";
import {
  ensureModel,
  removeModelByPath,
  initLanguage,
  setSharedEditor,
  setSharedMonaco,
} from "@/lib/language/model-manager";

export interface AskAISelection {
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
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
}

export function CodeEditor({
  projectId: _projectId,
  file,
  value,
  onChange,
  onSave,
  saving: _saving,
  onAskAI,
}: CodeEditorProps) {
  void _projectId;
  void _saving;
  const onAskAIRef = useRef(onAskAI);
  onAskAIRef.current = onAskAI;

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
    editor.focus();
  };

  // Tab switch: swap to the open file's model (created on open).
  // The layout disposes a file's model when its tab closes.
  useEffect(() => {
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

  const { resolvedTheme } = useTheme();
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "vs";

  if (!file) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file to begin editing.</div>;
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
