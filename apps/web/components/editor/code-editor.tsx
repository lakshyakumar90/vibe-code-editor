"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Editor from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { api } from "@/lib/api";
import type { ProjectFile } from "@/types/file";
import { getLanguage } from "@/lib/file-icons";
import { toast } from "sonner";

interface CodeEditorProps {
  projectId: string;
  file: ProjectFile | null;
  value: string;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  saving: boolean;
}

export function CodeEditor({ projectId, file, value, onChange, onSave, saving }: CodeEditorProps) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const { resolvedTheme } = useTheme();
  // resolvedTheme is undefined pre-mount — default to light to match SSR (no `dark` class on server).
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "vs";

  // global Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSave]);

  if (!file) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file to begin editing.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Editor
          key={file.id}
          height="100%"
          path={file.path}
          defaultValue={value}
          theme={monacoTheme}
          language={getLanguage(file.name)}
          onChange={(nextValue) => {
            onChange(nextValue ?? "");
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
              onSave();
            });
            editor.focus();
          }}
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
