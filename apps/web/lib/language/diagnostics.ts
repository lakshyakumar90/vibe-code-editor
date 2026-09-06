// Removed: problems/diagnostics panel (Bolt-style strip-down).
// Kept as no-op stubs so existing imports compile. Do not revive.
import type * as Monaco from "monaco-editor";

export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
  id: string;
  dbPath: string;
  severity: ProblemSeverity;
  message: string;
  code: string;
  line: number;
  column: number;
}

export function collectProblems(_monaco: typeof Monaco): Problem[] {
  return [];
}

export function onProblemsChange(
  _monaco: typeof Monaco,
  _cb: () => void,
): () => void {
  return () => {};
}
