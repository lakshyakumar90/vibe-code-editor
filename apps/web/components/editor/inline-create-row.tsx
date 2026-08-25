"use client";

import { getFileIcon } from "@/lib/file-icons";

interface Props {
  isFolder: boolean;
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  depth: number;
}

export function InlineCreateRow({ isFolder, value, onChange, onConfirm, onCancel, depth }: Props) {
  return (
    <div
      className="flex items-center gap-1 px-1 py-0.5"
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      {getFileIcon(value || (isFolder ? "folder" : "file.txt"), isFolder, false)}
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          if (value.trim()) onConfirm();
          else onCancel();
        }}
        placeholder={isFolder ? "folder name" : "file name"}
        className="flex-1 min-w-0 border border-primary bg-background px-1 py-0.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
      />
    </div>
  );
}
