import {z} from "zod";

const templateEnum = z.enum(["REACT", "VUE", "HONO", "EXPRESS", "NEXTJS", "ANGULAR"]);

// Accept "react", "React", " REACT " etc. — normalize before validating.
const templateSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  templateEnum
);

export const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Project name must be at least 2 characters long")
    .max(100, "Project name must be at most 100 characters long"),
  description: z
    .string()
    .max(500, "Project description must be at most 500 characters long")
    .optional(),
  template: templateSchema,
  memberIds: z.array(z.string()).default([]),
});

export const updateProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Project name must be at least 2 characters long")
    .max(100, "Project name must be at most 100 characters long"),
  description: z
    .string()
    .max(500, "Project description must be at most 500 characters long")
    .nullable()
    .optional()
})
  .refine(
    (data) =>
      data.name != undefined || data.description != undefined,
    {
      message: "At least one of name or description must be provided",
    }
  );

export const ProjectIdSchema = z.object({
  id: z.cuid2()
})

export const inviteMemberSchema = z.object({
  email: z.email("Invalid email address"),
  role: z.enum(["EDITOR", "VIEWER"]),
})
