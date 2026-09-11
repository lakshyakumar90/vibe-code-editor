import { z } from "zod";

export const importRepoSchema = z.object({
  owner: z.string().trim().min(1).max(100),
  repo: z.string().trim().min(1).max(100),
  // Repo-relative application root, e.g. "apps/web". Omitted/empty = repo root.
  root: z.string().trim().max(500).optional(),
});

export type ImportRepoInput = z.infer<typeof importRepoSchema>;
