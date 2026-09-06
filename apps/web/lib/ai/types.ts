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

export interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Mode that produced an assistant message. */
  mode?: AiPanelMode;
  /** Plan-mode checklist (rendered instead of prose when present). */
  plan?: PlanTask[];
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
  onStatus(text: string): void;
  onPlan(plan: PlanTask[]): void;
  /** Agent-mode changeset ready for review (Phase 4). Optional. */
  onChangeset?(changeSetId: string): void;
  onDone(): void;
  onError(message: string): void;
}

export interface SendOptions {
  projectId: string;
  mode: AiPanelMode;
  prompt: string;
  attachments: Attachment[];
  history: ChatMessage[];
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
