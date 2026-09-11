import { z } from "zod";

const pathsSchema = z.array(z.string().min(1).max(1024)).min(1).max(500);

export const gitPathsSchema = z.object({
  paths: pathsSchema,
});

export const gitDiffQuerySchema = z.object({
  path: z.string().min(1).max(1024),
  staged: z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
});

export const gitCommitSchema = z.object({
  message: z.string().min(1).max(2000),
});

export type GitPathsInput = z.infer<typeof gitPathsSchema>;
export type GitDiffQuery = z.infer<typeof gitDiffQuerySchema>;
export type GitCommitInput = z.infer<typeof gitCommitSchema>;
