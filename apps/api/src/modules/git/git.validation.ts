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

import { isValidBranchName } from "./git.paths";

const branchNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => isValidBranchName(v), "Invalid branch name");

const branchStartSchema = z
  .string()
  .max(128)
  .refine((v) => v === "HEAD" || isValidBranchName(v), "Invalid branch start point");

export const gitCreateBranchSchema = z.object({
  name: branchNameSchema,
  from: branchStartSchema.optional(),
});

export const gitCheckoutSchema = z.object({
  name: branchNameSchema,
});

export const gitPushSchema = z.object({
  branch: branchNameSchema.optional(),
});

export const gitHistoryQuerySchema = z.object({
  branch: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "Invalid commit SHA")
    .optional(),
});

export const gitHistoryDiffQuerySchema = z.object({
  path: z.string().min(1).max(1024),
});

export const gitCommitShaParamSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "Invalid commit SHA"),
});

export type GitPathsInput = z.infer<typeof gitPathsSchema>;
export type GitDiffQuery = z.infer<typeof gitDiffQuerySchema>;
export type GitCommitInput = z.infer<typeof gitCommitSchema>;
export type GitCreateBranchInput = z.infer<typeof gitCreateBranchSchema>;
export type GitCheckoutInput = z.infer<typeof gitCheckoutSchema>;
export type GitPushInput = z.infer<typeof gitPushSchema>;
export type GitHistoryQuery = z.infer<typeof gitHistoryQuerySchema>;
