import { z } from "zod";

const nameSchema = z
  .string()
  .trim()
  .min(1, { message: "Name is required" })
  .max(255, { message: "Name must be less than 255 characters" })
  .refine((name) => !name.includes("/") && !name.includes("\\"), {
    message: "Name cannot contain slashes",
  })
  .refine((name) => name !== "." && name !== "..", {
    message: "Name cannot be '.' or '..'",
  });

const parentIdSchema = z.cuid2().trim().nullable().optional();

export const upsertFileSchema = z
  .object({
    name: nameSchema,
    content: z
      .string()
      .max(5_000_000, "Content must be less than 5MB")
      .nullable()
      .optional(),
    parentId: parentIdSchema,
    isFolder: z.boolean(),
  })
  .superRefine((data, ctx) => {
    if (data.isFolder && data.content != null) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "Folders cannot contain file contenr",
      });
    }

    if (!data.isFolder && data.content == null) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "Files must contain file content",
      });
    }
  });

export const updateFileSchema = z.object({
  name: nameSchema.optional(),
  content: z
    .string()
    .max(5_000_000, "Content must be less than 5MB")
    .nullable()
    .optional(),
  parentId: parentIdSchema.optional(),
  isFolder: z.boolean().optional(),
});

export const filePathSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1, { message: "Path is required" })
    .max(2048, { message: "Path must be less than 2048 characters" }),
  projectId: z
    .string()
    .trim()
    .min(1, { message: "Project ID is required" }),
});

export const moveFileSchema = z.object({
  name: nameSchema,
  parentId: parentIdSchema,
})
