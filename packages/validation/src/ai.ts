import { z } from "zod";

// Mirrors AI_MODES / AI_PROVIDERS from @repo/ai (kept local so this
// package has zero runtime dependencies beyond zod).
const aiModes = ["ask", "plan", "agent"] as const;
const aiProviders = ["openai", "groq", "gemini", "ollama", "mock"] as const;

/** Labeled code context attached to a prompt (Ask-AI selection). */
export const attachmentSchema = z.object({
  filePath: z.string().max(2048),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  code: z.string().max(50000),
});

export const aiGenerateSchema = z.object({
  mode: z.enum(aiModes, { error: `mode must be one of: ${aiModes.join(", ")}` }),
  projectId: z.string().min(1, "projectId is required"),
  prompt: z.string().min(1, "prompt is required").max(10000, "prompt must be <= 10000 chars"),
  selection: z.string().max(50000).optional(),
  attachments: z.array(attachmentSchema).max(10).optional(),
  fileId: z.string().min(1).optional(),
  contextPaths: z.array(z.string().max(2048)).max(20).optional(),
  provider: z.enum(aiProviders).optional(),
  model: z.string().max(100).optional(),
  temperature: z.number().min(0).max(2).optional(),
  conversationId: z.string().optional(),
  planId: z.string().min(1).max(100).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().max(10000),
      }),
    )
    .max(20)
    .optional(),
});

export const aiCompleteSchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  fileId: z.string().optional(),
  filePath: z.string().max(2048).optional(),
  language: z.string().max(30).optional(),
  cursor: z.object({
    line: z.number().int().min(1),
    column: z.number().int().min(1),
    offset: z.number().int().min(0),
  }),
  prefix: z.string().max(20000),
  suffix: z.string().max(20000).optional(),
  provider: z.enum(aiProviders).optional(),
  model: z.string().max(100).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

/** Shape returned by POST /api/ai/complete. */
export const inlineCompletionResultSchema = z.object({
  completion: z.string().max(20000),
});

/** Frontend posts the approved/declined terminal command result here. */
export const aiCommandResultSchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  commandId: z.string().min(1, "commandId is required").max(100),
  approved: z.boolean(),
  output: z.string().max(20000).optional(),
  exitCode: z.number().int().min(-1).max(255).optional(),
});

/** Frontend posts the build verification outcome here. */
export const aiVerifyResultSchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  verificationId: z.string().min(1, "verificationId is required").max(100),
  approved: z.boolean(),
  output: z.string().max(20000).optional(),
  exitCode: z.number().int().min(-1).max(255).optional(),
  command: z.string().max(500).optional(),
});

export type AiGenerateInput = z.infer<typeof aiGenerateSchema>;
export type AiCompleteInput = z.infer<typeof aiCompleteSchema>;
export type AttachmentInput = z.infer<typeof attachmentSchema>;
