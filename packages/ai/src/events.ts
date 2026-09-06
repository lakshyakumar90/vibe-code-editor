/**
 * SSE event envelope shared by the API streamer (Phase 3) and the web
 * SSE reader (Phase 2). Wire format per event:
 *
 *   event: <type>\n
 *   data: <JSON of data>\n
 *   \n
 */

export const AI_EVENT_TYPES = [
  "token",
  "status",
  "plan",
  "changeset",
  "error",
  "done",
] as const;
export type AiEventType = (typeof AI_EVENT_TYPES)[number];

export interface AiStreamEvent<T = unknown> {
  type: AiEventType;
  data: T;
  seq: number;
  timestamp: string;
}

export interface TokenEventData {
  token: string;
}

export interface StatusEventData {
  status: string;
  message?: string;
}

export interface ChangeSetEventData {
  changeSetId: string;
  files: string[];
}

export interface DoneEventData {
  status: "completed" | "failed" | "stopped";
  changeSetId?: string;
  planId?: string;
}

export interface ErrorEventData {
  code: string;
  message: string;
}

let seqCounter = 0;

/** Build a timestamped, sequenced event (server side). */
export function makeEvent<T>(type: AiEventType, data: T): AiStreamEvent<T> {
  seqCounter += 1;
  return { type, data, seq: seqCounter, timestamp: new Date().toISOString() };
}

/** Serialize one event to SSE wire bytes. */
export function serializeSSE(event: AiStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** Serialize a keep-alive comment (prevents proxy timeouts). */
export function serializeKeepAlive(): string {
  return `: keepalive\n\n`;
}

/**
 * Parse one SSE `data:` payload line back into `{ type, data }`.
 * Returns null for keep-alive comments / blank lines / malformed rows.
 */
export function parseSSEBlock(
  eventType: string,
  dataLine: string,
): { type: AiEventType; data: unknown } | null {
  if (!AI_EVENT_TYPES.includes(eventType as AiEventType)) return null;
  try {
    return { type: eventType as AiEventType, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}
