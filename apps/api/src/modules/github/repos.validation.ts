import { z } from "zod";

export const listReposQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().trim().max(100).optional(),
});

export type ListReposQuery = z.infer<typeof listReposQuerySchema>;
