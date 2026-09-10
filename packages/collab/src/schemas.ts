import { z } from "zod";
import { CLIENT_MESSAGE_TYPES } from "./protocol.js";
import type { ClientMessage } from "./protocol.js";

const projectIdSchema = z.string().min(1).max(256);

const projectJoinSchema = z
  .object({
    type: z.literal("project.join"),
    projectId: projectIdSchema,
  })
  .strict();

const projectLeaveSchema = z
  .object({
    type: z.literal("project.leave"),
    projectId: projectIdSchema,
  })
  .strict();

const presenceUpdateSchema = z
  .object({
    type: z.literal("presence.update"),
    projectId: projectIdSchema,
    status: z.enum(["online", "away"]),
  })
  .strict();

const pingSchema = z
  .object({
    type: z.literal("ping"),
    ts: z.number().int().nonnegative(),
  })
  .strict();

export const clientMessageSchema = z.discriminatedUnion("type", [
  projectJoinSchema,
  projectLeaveSchema,
  presenceUpdateSchema,
  pingSchema,
]);

export type ParsedClientMessage = ClientMessage;

export interface ParseFailure {
  ok: false;
  requestType?: string;
  reason: string;
}

export interface ParseSuccess {
  ok: true;
  message: ClientMessage;
}

/**
 * Parse + validate an unknown inbound payload.
 * Never throws. Unknown `type` values yield a MALFORMED failure
 * instead of crashing the connection.
 */
export function parseClientMessage(
  input: unknown,
): ParseSuccess | ParseFailure {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "payload must be a JSON object" };
  }
  const record = input as Record<string, unknown>;
  const requestType =
    typeof record["type"] === "string" ? record["type"] : undefined;
  if (
    requestType !== undefined &&
    !(CLIENT_MESSAGE_TYPES as readonly string[]).includes(requestType)
  ) {
    return {
      ok: false,
      requestType,
      reason: `unknown message type: ${requestType}`,
    };
  }
  const parsed = clientMessageSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      requestType,
      reason: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "message"}: ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, message: parsed.data };
}

/** Safely JSON-parse raw WS text. Returns undefined for non-JSON. */
export function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
