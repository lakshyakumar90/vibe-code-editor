import type * as Monaco from "monaco-editor";
import { WORKSPACE_PREFIX, workspaceToDbPath } from "@/lib/workspace/paths";

export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
  /** Key for React lists. */
  id: string;
  /** Normalized db path ("src/App.tsx"). */
  dbPath: string;
  severity: ProblemSeverity;
  message: string;
  code: string;
  line: number;
  column: number;
}

function toSeverity(
  severity: Monaco.MarkerSeverity,
  monaco: typeof Monaco,
): ProblemSeverity {
  if (severity === monaco.MarkerSeverity.Error) return "error";
  if (severity === monaco.MarkerSeverity.Warning) return "warning";
  return "info";
}

/**
 * Editor diagnostics for project files only (filters out library /
 * non-project models). Sorted: errors first, then by path/line.
 */
export function collectProblems(monaco: typeof Monaco): Problem[] {
  const markers = monaco.editor.getModelMarkers({});
  const out: Problem[] = [];

  for (const marker of markers) {
    const uri = marker.resource.toString();
    if (!uri.startsWith(`file://${WORKSPACE_PREFIX}/`)) continue;
    // Skip virtual declaration files (node_modules extra libs).
    const dbPath = workspaceToDbPath(
      uri.replace(/^file:\/\//, ""),
    );
    if (dbPath.startsWith("node_modules/")) continue;

    out.push({
      id: `${dbPath}:${marker.startLineNumber}:${marker.startColumn}:${marker.code}:${marker.message}`,
      dbPath,
      severity: toSeverity(marker.severity, monaco),
      message: marker.message,
      code: String(marker.code ?? ""),
      line: marker.startLineNumber,
      column: marker.startColumn,
    });
  }

  const rank: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };
  out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (a.dbPath < b.dbPath ? -1 : a.dbPath > b.dbPath ? 1 : 0) ||
      a.line - b.line,
  );
  return out;
}

/** Subscribe to marker changes; returns an unsubscribe function. */
export function onProblemsChange(
  monaco: typeof Monaco,
  cb: () => void,
): () => void {
  const disposable = monaco.editor.onDidChangeMarkers(() => cb());
  return () => disposable.dispose();
}
