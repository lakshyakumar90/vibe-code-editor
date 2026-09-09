import type {
  AiMode,
  Attachment,
  ChatMessage,
  PlanTask,
} from "@repo/ai";

/** Panel modes mirror the server mode set exactly (no fourth mode). */
export type AiPanelMode = AiMode;

/** An attachment chip in the input area (Ask-AI selection or manual). */
export interface AttachmentChip extends Attachment {
  id: string;
}

/** One completed tool call in a plan/agent run — appended, never overwritten. */
export interface ToolStep {
  tool: string;
  args: Record<string, unknown>;
  resultSummary: string;
  timestamp: string;
}

/** Agent-requested terminal command (approval-gated, runs in WebContainer). */
export interface AgentCommand {
  commandId: string;
  command: string;
  state: "pending" | "running" | "done" | "declined";
  output?: string;
  exitCode?: number;
}

export interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Mode that produced an assistant message. */
  mode?: AiPanelMode;
  /** Plan-mode checklist (rendered instead of prose when present). */
  plan?: PlanTask[];
  /** Persistent tool-activity timeline (plan/agent modes). */
  steps?: ToolStep[];
  /** Agent-mode changeset attached to this message (Cursor-style file list). */
  changeSetId?: string;
  changeSetFiles?: string[];
  /** Agent-requested terminal commands (approval cards, agent mode). */
  commands?: AgentCommand[];
  feedback?: "up" | "down" | null;
  streaming?: boolean;
}

/** A file the user may attach via the plus-button. */
export interface AttachableFile {
  id: string;
  path: string;
  content: string;
}

export interface TransportEvents {
  onToken(token: string): void;
  onStatus(text: string, tool?: { name: string; args: Record<string, unknown> }): void;
  onPlan(plan: PlanTask[]): void;
  /** Agent-mode changeset ready for review (Phase 4). Optional. */
  onChangeset?(changeSetId: string, files?: string[]): void;
  /** Agent wants to run a terminal command (frontend executes after approval). */
  onRunCommand?(req: { commandId: string; command: string }): void;
  onDone(): void;
  onError(message: string): void;
}

export interface SendOptions {
  projectId: string;
  mode: AiPanelMode;
  prompt: string;
  attachments: Attachment[];
  history: ChatMessage[];
  provider?: string;
  model?: string;
}

/**
 * Message transport. Phase 2 ships MockTransport (local simulation);
 * Phase 3 adds SseTransport hitting POST /api/ai/generate with the
 * same interface — the panel never changes.
 */
export interface AiTransport {
  send(opts: SendOptions, events: TransportEvents): void;
  abort(): void;
  readonly aborted: boolean;
}
