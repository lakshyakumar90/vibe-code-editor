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

// -- Phase 4B.5: remote setup & publish ----------------------------------------

// Slug twins of repos.service:isValidRepoSegment / isValidRepoName.
// Duplicated (not imported) so request validation never depends on the
// GitHub API module; both sides assert the same rule and tests pin it.
const repoSlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/, "Invalid GitHub owner/name")
  .refine((v) => v !== "." && v !== "..", "Invalid GitHub owner/name");

const repoNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "Invalid repository name")
  .refine((v) => v !== "." && v !== "..", "Invalid repository name");

export const gitAttachRemoteSchema = z.object({
  owner: repoSlugSchema,
  repo: repoSlugSchema,
});

export const gitPublishSchema = z.object({
  name: repoNameSchema,
  description: z.string().max(1000).optional(),
  private: z.boolean(),
  organization: repoSlugSchema.nullish(),
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
export type GitAttachRemoteInput = z.infer<typeof gitAttachRemoteSchema>;
export type GitPublishInput = z.infer<typeof gitPublishSchema>;
export type GitHistoryQuery = z.infer<typeof gitHistoryQuerySchema>;
