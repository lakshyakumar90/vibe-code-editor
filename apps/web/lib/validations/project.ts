import { z } from "zod";

export const templates = [
  "REACT",
  "VUE",
  "HONO",
  "EXPRESS",
  "NEXTJS",
  "ANGULAR",
] as const;

export const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Project name is required")
    .max(50, "Project name must be 50 characters or less"),

  description: z
    .string()
    .trim()
    .max(500, "Description must be 500 characters or less")
    .optional(),

  template: z.enum(templates, {
    message: "Please select a template",
  }),

  memberIds: z
    .array(z.string())
    .default([]),
});

export type CreateProjectInput = z.infer<
  typeof createProjectSchema
>;