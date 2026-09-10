import { z } from "zod";
import { EDITOR_MESSAGE_TYPES, parseEditorDocId } from "./editor.js";
import type { EditorClientMessage } from "./editor.js";

const idSchema = z.string().min(1).max(256);

const docIdSchema = z
  .string()
  .min(3)
  .max(600)
  .refine((v) => parseEditorDocId(v) !== null, {
    message: "docId must be '<projectId>:<fileId>'",
  });

// Base64 (standard alphabet, padding allowed). Size is enforced separately.
const base64Schema = z
  .string()
  .min(1)
  .max(8 * 1024 * 1024)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, { message: "must be base64" });

const cursorSchema = z
  .object({
    lineNumber: z.number().int().min(1).max(1_000_000),
    column: z.number().int().min(1).max(1_000_000),
  })
  .strict();

const selectionSchema = z
  .object({
    startLineNumber: z.number().int().min(1).max(1_000_000),
    startColumn: z.number().int().min(1).max(1_000_000),
    endLineNumber: z.number().int().min(1).max(1_000_000),
    endColumn: z.number().int().min(1).max(1_000_000),
  })
  .strict();

const relAnchorSchema = z
  .object({
    client: z.number().int().min(0),
    clock: z.number().int().min(0),
    assoc: z.number().int(),
    tname: z.string().max(256).optional(),
  })
  .strict();

const editorJoinSchema = z
  .object({
    type: z.literal("editor.join"),
    projectId: idSchema,
    fileId: idSchema,
    sv: base64Schema.max(256 * 1024).optional(),
  })
  .strict();

const editorLeaveSchema = z
  .object({
    type: z.literal("editor.leave"),
    projectId: idSchema,
    fileId: idSchema,
  })
  .strict();

const editorUpdateSchema = z
  .object({
    type: z.literal("editor.update"),
    docId: docIdSchema,
    update: base64Schema,
  })
  .strict();

const editorAwarenessSchema = z
  .object({
    type: z.literal("editor.awareness"),
    projectId: idSchema,
    fileId: idSchema,
    cursor: cursorSchema,
    selection: selectionSchema.nullish(),
    cursorRel: relAnchorSchema.nullish(),
    selectionRel: z
      .object({
        anchor: relAnchorSchema.nullish(),
        head: relAnchorSchema.nullish(),
      })
      .strict()
      .nullish(),
  })
  .strict();

export const editorClientMessageSchema = z.discriminatedUnion("type", [
  editorJoinSchema,
  editorLeaveSchema,
  editorUpdateSchema,
  editorAwarenessSchema,
]);

export interface EditorParseSuccess {
  ok: true;
  message: EditorClientMessage;
}

export interface EditorParseFailure {
  ok: false;
  requestType?: string;
  reason: string;
}

/**
 * Validate an inbound editor payload (already routed by `type` through
 * the gateway's custom-handler seam). Never throws. Identity fields, if
 * smuggled in, are rejected by `.strict()` — the server attaches identity
 * itself on broadcast.
 */
export function parseEditorMessage(
  input: unknown,
): EditorParseSuccess | EditorParseFailure {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "payload must be a JSON object" };
  }
  const record = input as Record<string, unknown>;
  const requestType =
    typeof record["type"] === "string" ? record["type"] : undefined;
  if (
    requestType === undefined ||
    !(EDITOR_MESSAGE_TYPES as readonly string[]).includes(requestType)
  ) {
    return {
      ok: false,
      requestType,
      reason: `unknown editor message type: ${requestType ?? "missing"}`,
    };
  }
  const parsed = editorClientMessageSchema.safeParse(input);
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

/**
 * Base64 helpers that work in both runtimes (`apps/api` Node and
 * `apps/web` browser) — no `Buffer` dependency.
 */
export function decodeUpdate(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    if (binary.length === 0) {
      return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function encodeUpdate(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Byte length of a base64 payload without decoding it. */
export function base64ByteLength(base64: string): number {
  let padding = 0;
  if (base64.endsWith("==")) {
    padding = 2;
  } else if (base64.endsWith("=")) {
    padding = 1;
  }
  return Math.floor((base64.length * 3) / 4) - padding;
}
