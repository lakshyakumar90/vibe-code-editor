import * as fs from "node:fs";
import * as path from "node:path";
import { prisma } from "@repo/db";
import { normalizeGitPath, resolveWorktreePath } from "./git.paths";
import { hasGitDir, worktreeDirFor } from "./git.store";
import { isExcludedPath } from "../github/import.service";

/**
 * Phase 4A — File rows ↔ worktree synchronization.
 * Phase 4B — importRoot-aware: IDE paths map to git paths as
 * `<importRoot>/<idePath>` ("" = identity). Monorepo siblings never sync.
 *
 * Direction of truth:
 *   File rows (Postgres)  →  worktree files   (on save/create/delete/move/AI-apply)
 *   worktree files        →  File rows        (after git discard/checkout/pull)
 *
 * All save-path helpers are best-effort and NEVER throw into file
 * operations: a Git sync failure must not break saves. No-ops when the
 * project has no initialized GitRepository.
 */

/** IDE-relative path → git path under the import root. Pure. */
export function toGitPath(importRoot: string, idePath: string): string {
  const cleanRoot = importRoot.replace(/^\/+|\/+$/g, "");
  return cleanRoot === "" ? idePath : `${cleanRoot}/${idePath}`;
}

/**
 * Git path → IDE-relative path, or null when outside the import root
 * (monorepo siblings are never exposed). Pure.
 */
export function toIdePath(importRoot: string, gitPath: string): string | null {
  const cleanRoot = importRoot.replace(/^\/+|\/+$/g, "");
  if (cleanRoot === "") return gitPath;
  const prefix = `${cleanRoot}/`;
  if (gitPath === cleanRoot) return null;
  if (!gitPath.startsWith(prefix)) return null;
  const rest = gitPath.slice(prefix.length);
  return rest.length > 0 ? rest : null;
}

export interface BackedDir {
  dir: string;
  importRoot: string;
}

async function initializedWorktreeDir(projectId: string): Promise<BackedDir | null> {
  let link: { id: string; initializedAt: Date | null; importRoot: string | null } | null;
  try {
    link = await prisma.gitRepository.findUnique({
      where: { projectId },
      select: { id: true, initializedAt: true, importRoot: true },
    });
  } catch {
    return null;
  }
  if (!link || !link.initializedAt) return null;
  const dir = worktreeDirFor(link.id);
  if (!(await hasGitDir(dir))) return null;
  return { dir, importRoot: link.importRoot ?? "" };
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
    const backed = await initializedWorktreeDir(projectId);
    if (!backed) return;
    const row = await prisma.file.findFirst({
      where: { id: fileId, projectId },
      select: { path: true, content: true, isFolder: true },
    });
    if (!row) return;
    const repoPath = normalizeGitPath(toGitPath(backed.importRoot, row.path));
    if (row.isFolder) {
      const abs = resolveWorktreePath(backed.dir, repoPath);
      await fs.promises.mkdir(abs, { recursive: true });
      return;
    }
    await writeWorktreeFile(backed.dir, repoPath, row.content ?? "");
  } catch (err) {
    console.error("[git:sync] syncFileToWorktree failed", String(err).slice(0, 300));
  }
}

/** Remove one IDE-relative path from the worktree (DB delete). Never throws. */
export async function removePathFromWorktree(projectId: string, idePath: string): Promise<void> {
  try {
    const backed = await initializedWorktreeDir(projectId);
    if (!backed) return;
    await removeWorktreePath(backed.dir, normalizeGitPath(toGitPath(backed.importRoot, idePath)));
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
 * Materialize ALL File rows of a project into a directory (bootstrap,
 * clone-migration overlay). `prefix` scopes writes under an import root.
 * Throws on failure — bootstrap is an explicit operation, not a save path.
 */
export async function materializeProjectToDir(
  projectId: string,
  dir: string,
  prefix = "",
): Promise<{ files: number }> {
  const rows = await prisma.file.findMany({
    where: { projectId },
    select: { path: true, content: true, isFolder: true },
    orderBy: { path: "asc" },
  });
  let files = 0;
  for (const row of rows) {
    const repoPath = normalizeGitPath(toGitPath(prefix, row.path));
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
  binary: boolean;
}

/** Read worktree files back (discard reconcile). Throws on jail violations. */
export async function readWorktreeFiles(dir: string, repoPaths: string[]): Promise<WorktreeRead[]> {
  const out: WorktreeRead[] = [];
  for (const repoPath of repoPaths.slice(0, 500)) {
    const normalized = normalizeGitPath(repoPath);
    const abs = resolveWorktreePath(dir, normalized);
    let content: string | null = null;
    let missing = false;
    let binary = false;
    try {
      const st = await fs.promises.stat(abs);
      if (st.isDirectory()) {
        missing = true; // A directory where a file is expected — treat as missing.
      } else if (st.size > 5 * 1024 * 1024) {
        throw new Error("Worktree file too large to reconcile");
      } else {
        const bytes = await fs.promises.readFile(abs);
        if (bytes.includes(0)) {
          binary = true;
        } else {
          content = bytes.toString("utf8");
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        missing = true;
      } else {
        throw err;
      }
    }
    out.push({ path: normalized, content, missing, binary });
  }
  return out;
}

/** Max bytes reconciled per file (clone trees may hold large assets). */
const RECONCILE_MAX_BYTES = 1 * 1024 * 1024;

function looksBinaryBytes(bytes: Buffer): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** Recursively list files under the import scope (git-relative posix paths). */
async function walkScopedFiles(dir: string, importRoot: string): Promise<string[]> {
  const base = importRoot === "" ? dir : resolveWorktreePath(dir, normalizeGitPath(importRoot));
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const entryAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(entryAbs, entryRel);
      } else if (entry.isFile()) {
        out.push(importRoot === "" ? entryRel : `${importRoot}/${entryRel}`);
      }
    }
  }
  // Guard the scope root itself through the jail.
  if (importRoot !== "") {
    try {
      const st = await fs.promises.stat(base);
      if (!st.isDirectory()) return [];
    } catch {
      return [];
    }
  }
  await walk(base, "");
  return out;
}

export interface ReconcileResult {
  /** File ids whose content was created or updated (for content broadcast). */
  changedFileIds: string[];
  /** IDE paths removed from the DB. */
  deletedPaths: string[];
  filesUpserted: number;
  filesDeleted: number;
}

/**
 * Full worktree → DB reconcile scoped to the import root (checkout/pull).
 * Updates changed rows (ids preserved), creates missing rows (folders
 * ensured), deletes rows whose files vanished. Worktree files that cannot
 * become File rows (excluded paths, binaries, oversized) are skipped, and
 * folder rows are only removed when childless AND their dir is gone (git
 * never tracks empty dirs, so emptiness alone must not delete).
 */
export async function reconcileWorktreeToDb(
  projectId: string,
  dir: string,
  importRoot: string,
  userId: string,
): Promise<ReconcileResult> {
  const gitPaths = await walkScopedFiles(dir, importRoot);
  const rows = await prisma.file.findMany({
    where: { projectId },
    select: { id: true, path: true, content: true, isFolder: true, parentId: true },
  });
  const byIdePath = new Map(rows.map((r) => [r.path, r]));
  const changedFileIds: string[] = [];
  const deletedPaths: string[] = [];
  let filesUpserted = 0;
  let filesDeleted = 0;

  const seenIde = new Set<string>();
  for (const gitPath of gitPaths) {
    const idePath = toIdePath(importRoot, gitPath);
    if (idePath === null) continue; // Outside scope — never touch.
    if (isExcludedPath(idePath)) continue;
    seenIde.add(idePath);
    let content: string;
    try {
      const abs = resolveWorktreePath(dir, normalizeGitPath(gitPath));
      const st = await fs.promises.stat(abs);
      if (!st.isFile() || st.size > RECONCILE_MAX_BYTES) continue;
      const bytes = await fs.promises.readFile(abs);
      if (looksBinaryBytes(bytes)) continue;
      content = bytes.toString("utf8");
    } catch {
      continue;
    }
    const existing = byIdePath.get(idePath);
    if (existing) {
      if (!existing.isFolder && existing.content !== content) {
        await prisma.file.update({
          where: { id: existing.id },
          data: { content, updatedByUserId: userId },
        });
        changedFileIds.push(existing.id);
        filesUpserted += 1;
      }
    } else {
      const parent = idePath.includes("/") ? idePath.slice(0, idePath.lastIndexOf("/")) : null;
      const parentId = parent ? await ensureFolderRow(projectId, parent, userId) : null;
      const created = await prisma.file.create({
        data: {
          projectId,
          name: idePath.split("/").pop() ?? idePath,
          content,
          parentId,
          isFolder: false,
          path: idePath,
          updatedByUserId: userId,
        },
      });
      byIdePath.set(idePath, { ...created, parentId });
      changedFileIds.push(created.id);
      filesUpserted += 1;
    }
  }

  // Remove file rows whose files vanished from the worktree.
  for (const row of rows) {
    if (row.isFolder) continue;
    const gitPath = toGitPath(importRoot, row.path);
    const stillThere = gitPaths.includes(gitPath);
    if (!stillThere) {
      await prisma.file.delete({ where: { id: row.id } }).catch(() => null);
      deletedPaths.push(row.path);
      filesDeleted += 1;
      byIdePath.delete(row.path);
    }
  }

  // Remove folder rows that are childless AND whose dir is gone.
  const remaining = await prisma.file.findMany({
    where: { projectId },
    select: { id: true, path: true, isFolder: true, parentId: true },
  });
  const childCount = new Map<string, number>();
  for (const r of remaining) {
    if (r.parentId) childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);
  }
  for (const r of remaining) {
    if (!r.isFolder) continue;
    if ((childCount.get(r.id) ?? 0) > 0) continue;
    const gitPath = toGitPath(importRoot, r.path);
    let dirGone = false;
    try {
      const abs = resolveWorktreePath(dir, normalizeGitPath(gitPath));
      const st = await fs.promises.stat(abs);
      dirGone = !st.isDirectory();
    } catch {
      dirGone = true;
    }
    if (dirGone) {
      await prisma.file.delete({ where: { id: r.id } }).catch(() => null);
    }
  }

  return { changedFileIds, deletedPaths, filesUpserted, filesDeleted };
}

async function ensureFolderRow(projectId: string, dirPath: string, userId: string): Promise<string | null> {
  if (!dirPath) return null;
  const existing = await prisma.file
    .findUnique({ where: { projectId_path: { projectId, path: dirPath } } })
    .catch(() => null);
  if (existing) return existing.id;
  const parent = dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : null;
  const parentId = parent ? await ensureFolderRow(projectId, parent, userId) : null;
  const created = await prisma.file.create({
    data: {
      projectId,
      name: dirPath.split("/").pop() ?? dirPath,
      content: null,
      parentId,
      isFolder: true,
      path: dirPath,
      updatedByUserId: userId,
    },
  });
  return created.id;
}
