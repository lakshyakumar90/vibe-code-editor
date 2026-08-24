"use client";

import {
  useEffect,
  useRef,
  useState,
} from "react";
import Editor from "@monaco-editor/react";
import { api } from "@/lib/api";
import type { ProjectFile } from "@/types/file";

interface CodeEditorProps {
  projectId: string;
  file: ProjectFile | null;
}

export function CodeEditor({
  projectId,
  file,
}: CodeEditorProps) {
  const [value, setValue] =
    useState("");

  const [saving, setSaving] =
    useState(false);

  const saveTimer =
    useRef<ReturnType<
      typeof setTimeout
    > | null>(null);

  useEffect(() => {
    if (!file) {
      setValue("");
      return;
    }

    setValue(file.content ?? "");
  }, [file]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(
          saveTimer.current,
        );
      }
    };
  }, []);

  function saveFile(
    nextValue: string,
  ) {
    if (!file || file.isFolder) {
      return;
    }

    if (saveTimer.current) {
      clearTimeout(
        saveTimer.current,
      );
    }

    saveTimer.current =
      setTimeout(async () => {
        try {
          setSaving(true);

          await api.put(
            `/api/projects/${projectId}/files/${file.id}`,
            {
              name: file.name,
              parentId: file.parentId,
              isFolder: false,
              content: nextValue,
            },
          );
        } catch (error) {
          console.error(
            "Failed to save file:",
            error,
          );
        } finally {
          setSaving(false);
        }
      }, 700);
  }

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center">
        Select a file to begin editing.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 items-center border-b px-4 text-sm">
        <span>{file.path}</span>

        {saving && (
          <span className="ml-auto">
            Saving...
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          path={file.path}
          value={value}
          theme="vs-dark"
          language={getLanguage(
            file.name,
          )}
          onChange={(nextValue) => {
            const next =
              nextValue ?? "";

            setValue(next);
            saveFile(next);
          }}
          onMount={(editor, monaco) => {
            editor.addCommand(
              monaco.KeyMod.CtrlCmd |
                monaco.KeyCode.KeyS,
              () => {
                saveFile(value);
              },
            );
          }}
          options={{
            automaticLayout: true,
            minimap: {
              enabled: true,
            },
            fontSize: 14,
            tabSize: 2,
          }}
        />
      </div>
    </div>
  );
}

function getLanguage(
  fileName: string,
) {
  const extension =
    fileName
      .split(".")
      .pop()
      ?.toLowerCase();

  switch (extension) {
    case "ts":
      return "typescript";

    case "tsx":
      return "typescript";

    case "js":
      return "javascript";

    case "jsx":
      return "javascript";

    case "json":
      return "json";

    case "css":
      return "css";

    case "scss":
      return "scss";

    case "html":
      return "html";

    case "md":
      return "markdown";

    default:
      return "plaintext";
  }
}