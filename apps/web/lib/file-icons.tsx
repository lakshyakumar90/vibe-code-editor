"use client";

import {
  Folder,
  FolderOpen,
  File,
  FileCode2,
  FileJson,
  FileText,
  Braces,
  Palette,
  FileImage,
  Settings,
} from "lucide-react";
import type { JSX } from "react";

export function getFileIcon(name: string, isFolder: boolean, expanded: boolean): JSX.Element {
  if (isFolder) {
    return expanded ? <FolderOpen className="size-4 shrink-0 text-amber-500" /> : <Folder className="size-4 shrink-0 text-amber-500" />;
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const cls = "size-4 shrink-0";
  switch (ext) {
    case "ts":
    case "tsx":
      return <FileCode2 className={`${cls} text-blue-500`} />;
    case "js":
    case "jsx":
      return <Braces className={`${cls} text-yellow-500`} />;
    case "json":
      return <FileJson className={`${cls} text-yellow-600`} />;
    case "css":
    case "scss":
      return <Palette className={`${cls} text-pink-500`} />;
    case "html":
      return <FileCode2 className={`${cls} text-orange-500`} />;
    case "md":
      return <FileText className={`${cls} text-gray-500`} />;
    case "png":
    case "jpg":
    case "jpeg":
    case "svg":
    case "webp":
      return <FileImage className={`${cls} text-green-500`} />;
    case "env":
    case "config":
      return <Settings className={`${cls} text-gray-400`} />;
    default:
      return <File className={`${cls} text-muted-foreground`} />;
  }
}

export function getLanguage(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": return "typescript";
    case "tsx": return "typescript";
    case "js": return "javascript";
    case "jsx": return "javascript";
    case "json": return "json";
    case "css": return "css";
    case "scss": return "scss";
    case "html": return "html";
    case "md": return "markdown";
    default: return "plaintext";
  }
}
