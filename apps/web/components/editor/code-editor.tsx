"use client";

import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import type { ProjectFile } from "@/types/file";
import { getLanguage } from "@/lib/file-icons";
import { ensureModel, initLanguage, setSharedMonaco } from "@/lib/language/model-manager";
import { flushPendingDependencyTypes } from "@/lib/language/dependency-loader";

interface CodeEditorProps {
  projectId: string;
  file: ProjectFile | null;
  value: string;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  saving: boolean;
  /** Template for TS compiler options. V1: REACT default. */
  template?: string;
}

export function CodeEditor({
  projectId: _projectId,
  file,
  value,
  onChange,
  onSave,
  saving: _saving,
  template = "REACT",
}: CodeEditorProps) {
  void _projectId;
  void _saving;

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
    initLanguage(monaco, template);
    flushPendingDependencyTypes();
    if (file) {
      activePathRef.current = file.path;
      editor.setModel(
        ensureModel(monaco, file.path, value, getLanguage(file.name)),
      );
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void onSaveRef.current();
    });
    editor.focus();
  };

  // Tab switch (or external update): swap to the stable per-path model.
  // Models persist across tabs — never recreated — so the TS worker keeps
  // full project context for cross-file imports.
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

  // External value sync (e.g. post-save refresh): typing flows
  // Monaco -> onChange -> parent, so equal values are a no-op here.
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

  const { resolvedTheme } = useTheme();
  // resolvedTheme is undefined pre-mount — default to light to match SSR (no `dark` class on server).
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
          }}
        />
      </div>
    </div>
  );
}
