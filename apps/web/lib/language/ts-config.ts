import type * as Monaco from "monaco-editor";

export type LanguageTemplate = "REACT" | "HONO" | "EXPRESS" | "NEXTJS";
export type RawCompilerOptions = Record<string, unknown>;

/**
 * Universal resolver for Monaco's TypeScript language service.
 */
export function getMonacoTypescript(
  monaco: typeof Monaco | unknown,
): typeof Monaco.typescript {
  const m = monaco as Record<string, unknown>;
  const languages = m?.languages as Record<string, unknown> | undefined;
  return (languages?.typescript ?? m?.typescript) as typeof Monaco.typescript;
}

// Removed: tsconfig-driven compiler options (Bolt-style strip-down).
// The editor uses a minimal no-resolve config from model-manager instead.
export function buildCompilerOptions(): null {
  return null;
}

export function getCompilerOptions(): null {
  return null;
}
