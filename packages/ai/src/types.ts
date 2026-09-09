/**
 * Shared AI contracts (Phase 0 — types only, no logic).
 *
 * Single source of truth for modes, providers, streaming events,
 * attachments, and changesets across `apps/api`, `apps/web`, and
 * future provider implementations (Phase 1+).
 */

/** Final Cursor-style mode set. `build` stays folded into `agent`. */
export const AI_MODES = ["ask", "plan", "agent"] as const;
export type AiMode = (typeof AI_MODES)[number];

/** Provider ids wired in Phase 1. `mock` is for dev/test without keys. */
export const AI_PROVIDERS = [
  "openai",
  "groq",
  "gemini",
  "ollama",
  "mock",
] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Labeled code context attached to a prompt (Ask-AI selection, Phase 3). */
export interface Attachment {
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
}

/** Result of a terminal command run (agent runCommand tool). */
export interface CommandResult {
  /** False when the user declined, the run timed out, or was cancelled. */
  approved: boolean;
  /** Combined stdout/stderr, truncated by the runner. */
  output: string;
  /** Process exit code (-1 when never executed). */
  exitCode: number;
}

/** One checklist item in a plan-mode response (Phase 2 renderer). */
export type PlanTaskStatus = "pending" | "in_progress" | "complete";

export interface PlanTask {
  title: string;
  status: PlanTaskStatus;
}

/** Whole-file change record (per-file granularity v1; per-hunk deferred). */
export interface FileChange {
  /** Workspace-relative posix path, e.g. `src/App.tsx`. */
  path: string;
  /** Full new file content. `null` + `delete: true` removes the file/folder. */
  content: string | null;
  delete?: boolean;
  /** Set for folder create/delete (content must be null). */
  isFolder?: boolean;
}

export interface ChangeSetInput {
  changes: FileChange[];
}

/** Request shape for a streamed chat/generate call (Phase 1+). */
export interface ChatRequest {
  messages: ChatMessage[];
  attachments?: Attachment[];
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

/** Request shape for a non-streamed inline completion (Phase 1+). */
export interface InlineRequest {
  prefix: string;
  suffix?: string;
  language?: string;
  filePath?: string;
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Provider interface implemented in Phase 1. Every provider must stream
 * real tokens (no single-flush fakes) — verified per provider before
 * Phase 4 per the plan gate.
 */
export interface AiProvider {
  readonly id: AiProviderId;
  readonly name: string;
  /** False when required env/keys are missing (caller falls back). */
  isConfigured(): boolean;
  defaultModel(): string;
  /** Async-iterable of raw text tokens. */
  streamChat(req: ChatRequest): AsyncIterable<string>;
  /** Single JSON completion for ghost-text (Phase 1+, currently out of scope for UI). */
  completeInline(req: InlineRequest): Promise<string>;
}
