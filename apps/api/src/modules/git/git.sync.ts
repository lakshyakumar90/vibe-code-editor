import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "@repo/db";
import { normalizeGitPath, resolveWorktreePath } from "./git.paths";
import { hasGitDir, worktreeDirFor } from "./git.store";

/**
 * Phase 4A — File rows ↔ worktree synchronization.
 *
 * Direction of truth:
 *   File rows (Postgres)  →  worktree files   (on save/create/delete/move/AI-apply)
 *   worktree files        →  File rows        (after git discard/checkout only)
 *
 * All helpers are best-effort and NEVER throw into file operations: a Git
 * sync failure must not break saves. No-ops when the project has no
 * initialized GitRepository.
 */

async function initializedWorktreeDir(projectId: string): Promise<string | null> {
  let link: { id: string; initializedAt: Date | null } | null;
  try {
    link = await prisma.gitRepository.findUnique({
      where: { projectId },
      select: { id: true, initializedAt: true },
    });
  } catch {
    return null;
  }
  if (!link || !link.initializedAt) return null;
  const dir = worktreeDirFor(link.id);
  if (!(await hasGitDir(dir))) return null;
  return dir;
}

async function writeWorktreeFile(dir: string, repoPath: string, content: string): Promise<void> {
  const abs = resolveWorktreePath(dir, repoPath);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, content, "utf8");
}

async function removeWorktreePath(dir: string, repoPath: string): Promise<void> {
  const abs = resolveWorktreePath(dir, repoPath);
  await fs.promises.rm(abs, { recursive: true, force: true });
}

/** Sync one DB file row into the worktree (create/update). Never throws. */
export async function syncFileToWorktree(projectId: string, fileId: string): Promise<void> {
  try {
    const dir = await initializedWorktreeDir(projectId);
    if (!dir) return;
    const row = await prisma.file.findFirst({
      where: { id: fileId, projectId },
      select: { path: true, content: true, isFolder: true },
    });
    if (!row) return;
    const repoPath = normalizeGitPath(row.path);
    if (row.isFolder) {
      const abs = resolveWorktreePath(dir, repoPath);
      await fs.promises.mkdir(abs, { recursive: true });
      return;
    }
    await writeWorktreeFile(dir, repoPath, row.content ?? "");
  } catch (err) {
    console.error("[git:sync] syncFileToWorktree failed", String(err).slice(0, 300));
  }
}

/** Remove one path from the worktree (DB delete). Never throws. */
export async function removePathFromWorktree(projectId: string, repoPath: string): Promise<void> {
  try {
    const dir = await initializedWorktreeDir(projectId);
    if (!dir) return;
    await removeWorktreePath(dir, normalizeGitPath(repoPath));
  } catch (err) {
    console.error("[git:sync] removePathFromWorktree failed", String(err).slice(0, 300));
  }
}

/** Sync several DB rows into the worktree (AI apply, batch paths). Never throws. */
export async function syncPathsToWorktree(projectId: string, fileIds: string[]): Promise<void> {
  for (const fileId of fileIds.slice(0, 500)) {
    await syncFileToWorktree(projectId, fileId);
  }
}

/**
 * Materialize ALL File rows of a project into a directory (bootstrap).
 * Throws on failure — bootstrap is an explicit operation, not a save path.
 */
export async function materializeProjectToDir(projectId: string, dir: string): Promise<{ files: number }> {
  const rows = await prisma.file.findMany({
    where: { projectId },
    select: { path: true, content: true, isFolder: true },
    orderBy: { path: "asc" },
  });
  let files = 0;
  for (const row of rows) {
    const repoPath = normalizeGitPath(row.path);
    if (row.isFolder) {
      const abs = resolveWorktreePath(dir, repoPath);
      await fs.promises.mkdir(abs, { recursive: true });
      continue;
    }
    await writeWorktreeFile(dir, repoPath, row.content ?? "");
    files += 1;
  }
  return { files };
}

export interface WorktreeRead {
  path: string;
  content: string | null;
  missing: boolean;
}

/** Read worktree files back (discard reconcile). Throws on jail violations. */
export async function readWorktreeFiles(dir: string, repoPaths: string[]): Promise<WorktreeRead[]> {
  const out: WorktreeRead[] = [];
  for (const repoPath of repoPaths.slice(0, 500)) {
    const normalized = normalizeGitPath(repoPath);
    const abs = resolveWorktreePath(dir, normalized);
    let content: string | null = null;
    let missing = false;
    try {
      const st = await fs.promises.stat(abs);
      if (st.isDirectory()) {
        missing = true; // A directory where a file is expected — treat as missing.
      } else if (st.size > 5 * 1024 * 1024) {
        throw new Error("Worktree file too large to reconcile");
      } else {
        content = await fs.promises.readFile(abs, "utf8");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        missing = true;
      } else {
        throw err;
      }
    }
    out.push({ path: normalized, content, missing });
  }
  return out;
}
