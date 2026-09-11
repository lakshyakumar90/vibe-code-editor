import { createId } from "@paralleldrive/cuid2";
import type { TemplateId } from "@repo/templates/detect";
import { getManifest } from "@repo/templates";
import {
  fetchFileBlob,
  fetchRepoDetail,
  fetchRepoTreeEntries,
  inspectRepository,
  isValidRepoSegment,
  MAX_INSPECT_ROOTS,
  MAX_TREE_PATHS,
  type GitHubFetch,
  type TreeEntry,
} from "./repos.service";

/**
 * Phase 3 — GitHub repository import.
 *
 * GitHub is the source used to import the project; Postgres Project + File
 * becomes the IDE's source of truth afterwards. GitRepository records only
 * the remote binding + imported revision. No Git execution anywhere here.
 *
 * Import safety limits are explicit, centralized, server-enforced, tested.
 */
export const IMPORT_LIMITS = {
  /** Max importable files per import (after exclusions). */
  maxFiles: 1000,
  /** Max cumulative decoded bytes of imported files. */
  maxTotalBytes: 10 * 1024 * 1024,
  /** Max decoded bytes of a single file (aligns with Contents API ~1MB). */
  maxFileBytes: 1 * 1024 * 1024,
  /** Bounded parallel blob fetches. */
  fetchConcurrency: 8,
} as const;

/** Directory segments never imported (generated, vendored, or VCS state). */
const EXCLUDED_DIR_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
]);

/**
 * Well-known binary extensions skipped WITHOUT fetching — such files can
 * never become UTF-8 File rows (they would be skipped as binary after
 * decoding), so failing the whole import on their size would be pure cost.
 * SVG is deliberately absent (valid UTF-8 text). Unknown extensions still go
 * through fetch → NUL-sniff → fatal-UTF8-decode, with fail-closed limits.
 */
const BINARY_SKIP_EXTENSIONS = new Set([
  // Images (raster).
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "avif", "heic",
  // Audio / video.
  "mp3", "wav", "ogg", "flac", "aac", "m4a", "opus",
  "mp4", "webm", "avi", "mov", "mkv",
  // Archives / compressed.
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
  // Fonts.
  "woff", "woff2", "ttf", "otf", "eot",
  // Binary documents.
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
]);

/** True for well-known binary formats (skipped pre-fetch, counted). Pure. */
export function isBinaryExtension(projectPath: string): boolean {
  const segs = projectPath.split("/");
  const base = segs[segs.length - 1]!;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_SKIP_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

export type ImportFailureCode =
  | "INVALID_REPO"
  | "INVALID_ROOT"
  | "GITHUB_NOT_CONNECTED"
  | "GITHUB_UNAUTHORIZED"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_REQUEST_FAILED"
  | "REPO_NOT_FOUND"
  | "IMPORT_INSPECTION_LIMIT"
  | "UNSUPPORTED_TEMPLATE"
  | "IMPORT_UNSAFE_PATH"
  | "IMPORT_TOO_MANY_FILES"
  | "IMPORT_TOO_LARGE"
  | "IMPORT_FILE_TOO_LARGE"
  | "IMPORT_EMPTY";

export interface ImportFailure {
  ok: false;
  code: ImportFailureCode;
  status: number;
  message: string;
  truncated?: boolean;
  reasons?: string[];
}

export interface ImportedFileRow {
  path: string;
  content: string;
}

export interface ImportStats {
  files: number;
  folders: number;
  totalBytes: number;
  skippedExcluded: number;
  skippedSymlinks: number;
  skippedSubmodules: number;
  skippedBinaries: number;
}

export interface ImportPlan {
  ok: true;
  projectId: string;
  project: {
    name: string;
    description: string | null;
    template: TemplateId;
    templateVersion: string;
    ownerId: string;
  };
  gitRepository: {
    githubRepoId: string;
    owner: string;
    repo: string;
    fullName: string;
    defaultBranch: string;
    currentBranch: string;
    importedSha: string;
    private: boolean;
    canRead: boolean;
    canWrite: boolean;
    canAdmin: boolean;
  };
  folderRows: BuiltRow[];
  fileRows: BuiltRow[];
  stats: ImportStats;
}

export type ImportResult = ImportPlan | ImportFailure;

const SEGMENT_RE = /^[^\0/\\]+$/;

/** Validate one path segment (no traversal, no separators, bounded). Pure. */
function isValidSegment(seg: string): boolean {
  return (
    seg.length >= 1 &&
    seg.length <= 255 &&
    seg !== "." &&
    seg !== ".." &&
    SEGMENT_RE.test(seg)
  );
}

/**
 * Normalize a client-supplied import root. "" = repository root.
 * Returns null for anything unsafe. Pure.
 */
export function normalizeImportRoot(raw: unknown): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  if (raw.includes("\\")) return null;
  const trimmed = raw.trim();
  const stripped = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  if (stripped === "" || stripped === ".") return "";
  const segs = stripped.split("/");
  if (segs.length > 4) return null;
  if (!segs.every(isValidSegment)) return null;
  return segs.join("/");
}

/**
 * Validate a GitHub tree path and map it to a project-relative path under
 * the selected root. Returns null when the path is unsafe or outside root.
 * Every repository path is untrusted input. Pure.
 */
export function toProjectPath(repoPath: unknown, root: string): string | null {
  if (typeof repoPath !== "string" || repoPath.length === 0 || repoPath.length > 2048) return null;
  if (repoPath.startsWith("/") || repoPath.includes("\\") || repoPath.includes("\0")) return null;
  const segs = repoPath.split("/");
  if (!segs.every(isValidSegment)) return null;
  if (root === "") return repoPath;
  const prefix = `${root}/`;
  if (!repoPath.startsWith(prefix)) return null;
  const rest = repoPath.slice(prefix.length);
  if (rest.length === 0 || rest.length > 2048) return null;
  if (!rest.split("/").every(isValidSegment)) return null;
  return rest;
}

/** True when a project-relative path must be excluded (generated/secrets). Pure. */
export function isExcludedPath(projectPath: string): boolean {
  const segs = projectPath.split("/");
  if (segs.some((s) => EXCLUDED_DIR_SEGMENTS.has(s))) return true;
  const base = segs[segs.length - 1]!;
  return base === ".env" || base.startsWith(".env.") || base.startsWith(".env_");
}

/** Conservative binary sniff: NUL byte in the first 8KB. Pure. */
export function looksBinary(bytes: Buffer): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** Strict UTF-8 decode; null when not representable as source text. Pure. */
export function decodeTextBytes(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface BuiltRow {
  id: string;
  name: string;
  path: string;
  content: string | null;
  isFolder: boolean;
  projectId: string;
  parentId: string | null;
  updatedByUserId?: string;
}

function nameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function parentPathOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i === -1 ? null : path.slice(0, i);
}

function depthOf(path: string): number {
  return path.split("/").length;
}

/**
 * Build deterministic, parent-linked File rows from project-relative files.
 * Folders are derived from parent prefixes and ordered shallow-first so
 * parentId always resolves — same convention as template project creation.
 * Pure (ids via cuid2).
 */
export function buildImportFileRows(
  projectId: string,
  files: ImportedFileRow[],
  updatedByUserId?: string,
): { folderRows: BuiltRow[]; fileRows: BuiltRow[] } {
  const seen = new Map<string, string>();
  for (const f of files) {
    if (!seen.has(f.path)) seen.set(f.path, f.content);
  }
  const folderPaths = new Set<string>();
  for (const path of seen.keys()) {
    let parent = parentPathOf(path);
    while (parent) {
      folderPaths.add(parent);
      parent = parentPathOf(parent);
    }
  }
  const folders = [...folderPaths].sort(
    (a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : 1),
  );
  const filePaths = [...seen.keys()].sort(
    (a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : 1),
  );

  const pathToId = new Map<string, string>();
  const attribution = updatedByUserId ? { updatedByUserId } : {};
  const folderRows = folders.map((folderPath) => {
    const parentPath = parentPathOf(folderPath);
    const id = createId();
    const row: BuiltRow = {
      id,
      name: nameOf(folderPath),
      path: folderPath,
      content: null,
      isFolder: true,
      projectId,
      parentId: parentPath ? (pathToId.get(parentPath) ?? null) : null,
      ...attribution,
    };
    pathToId.set(folderPath, id);
    return row;
  });
  const fileRows = filePaths.map((filePath) => {
    const parentPath = parentPathOf(filePath);
    return {
      id: createId(),
      name: nameOf(filePath),
      path: filePath,
      content: seen.get(filePath) ?? "",
      isFolder: false,
      projectId,
      parentId: parentPath ? (pathToId.get(parentPath) ?? null) : null,
      ...attribution,
    } as BuiltRow;
  });
  return { folderRows, fileRows };
}

export interface ImportRunInput {
  userId: string;
  owner: string;
  repo: string;
  root?: string;
  token: string;
  fetchImpl?: GitHubFetch;
}

interface CandidateFile {
  repoPath: string;
  projectPath: string;
  size: number | null;
}

function fail(
  code: ImportFailureCode,
  status: number,
  message: string,
  extra?: Partial<ImportFailure>,
): ImportFailure {
  return { ok: false, code, status, message, ...extra };
}

/**
 * Full import pipeline: GitHub fetch (outside any DB write) → validate the
 * complete payload → return everything for ONE atomic transaction.
 * Never writes. The caller runs a single prisma.$transaction with the
 * returned rows. Duplicate imports create separate projects (never overwrite).
 */
export async function planImport(input: ImportRunInput): Promise<ImportResult> {
  const fetchImpl: GitHubFetch = input.fetchImpl ?? fetch;
  const { userId, token, owner, repo } = input;

  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
    return fail("INVALID_REPO", 400, "Repository owner/name must be plain GitHub slugs");
  }
  const root = normalizeImportRoot(input.root);
  if (root === null) {
    return fail("INVALID_ROOT", 400, "Import root must be a plain relative directory path");
  }

  // 1. Repository must still be accessible with the CURRENT authorization.
  const detail = await fetchRepoDetail(token, owner, repo, fetchImpl);
  if (detail.error || !detail.repo) {
    const status = detail.error?.status ?? 502;
    if (status === 404) {
      return fail("REPO_NOT_FOUND", 404, "Repository not found or not accessible with this GitHub authorization.");
    }
    if (status === 401 || status === 403) {
      return fail("GITHUB_UNAUTHORIZED", 401, "GitHub rejected the stored authorization. Reconnect GitHub.");
    }
    if (detail.error?.rateLimited) {
      return fail("GITHUB_RATE_LIMITED", 429, "GitHub rate limit reached. Try again later.");
    }
    return fail("GITHUB_REQUEST_FAILED", 502, "Could not reach GitHub. Try again shortly.");
  }
  const meta = detail.repo;

  const ref = meta.latestSha ?? meta.defaultBranch;
  if (!ref) {
    return fail("GITHUB_REQUEST_FAILED", 502, "Could not determine the repository default branch.");
  }

  // 2. Full entry metadata (mode/type/size) — paths alone are not enough.
  const tree = await fetchRepoTreeEntries(token, owner, repo, ref, fetchImpl);
  if (tree.error) {
    const status = tree.error.status;
    if (status === 404) {
      return fail("REPO_NOT_FOUND", 404, "Repository not found or not accessible with this GitHub authorization.");
    }
    if (status === 401 || status === 403) {
      return fail("GITHUB_UNAUTHORIZED", 401, "GitHub rejected the stored authorization. Reconnect GitHub.");
    }
    return fail("GITHUB_REQUEST_FAILED", 502, "Could not reach GitHub. Try again shortly.");
  }

  // 3. Import safety limits are NOT template verdicts — distinguish them.
  const paths = tree.entries.map((e) => e.path);
  if (tree.truncated || paths.length > MAX_TREE_PATHS) {
    return fail(
      "IMPORT_INSPECTION_LIMIT",
      422,
      "Repository inspection is incomplete or exceeds the import safety limit.",
      { truncated: true },
    );
  }

  // 4. Reuse the Phase 2 inspection contract (fresh — never trust the browser).
  const built = await inspectRepository(
    token,
    owner,
    repo,
    meta.fullName,
    meta.defaultBranch,
    ref,
    { truncated: false, paths, error: null },
    fetchImpl,
  );
  const inspection = built.response;
  if (inspection.truncated || inspection.roots.length > MAX_INSPECT_ROOTS) {
    return fail(
      "IMPORT_INSPECTION_LIMIT",
      422,
      "Repository inspection is incomplete or exceeds the import safety limit.",
      { truncated: true },
    );
  }

  // 5. Validate the selected root + template server-side.
  const detection = inspection.detection;
  if (detection.kind === "unsupported") {
    return fail("UNSUPPORTED_TEMPLATE", 422, "No supported project template was detected.", {
      reasons: detection.reasons,
    });
  }
  const rootEntry = inspection.roots.find((r) => r.root === root);
  if (!rootEntry) {
    return fail(
      "INVALID_ROOT",
      400,
      root === ""
        ? "This repository has no importable application at its root. Choose an application root."
        : `Import root "${root}" does not match any application in this repository.`,
    );
  }
  if (rootEntry.detection.kind !== "supported") {
    return fail("UNSUPPORTED_TEMPLATE", 422, "No supported project template was detected.", {
      reasons:
        rootEntry.detection.kind === "unsupported" ? rootEntry.detection.reasons : detection.reasons,
    });
  }
  const template = rootEntry.detection.template;

  // 6. Select blob entries under the root; classify the rest.
  const prefix = root === "" ? "" : `${root}/`;
  let skippedSymlinks = 0;
  let skippedSubmodules = 0;
  let skippedExcluded = 0;
  let skippedBinaries = 0;
  const candidates: CandidateFile[] = [];
  for (const entry of tree.entries as TreeEntry[]) {
    if (root !== "" && !(entry.path === root || entry.path.startsWith(prefix))) continue;
    if (entry.type === "commit" || entry.mode === "160000") {
      skippedSubmodules += 1;
      continue;
    }
    if (entry.type !== "blob" || entry.mode === "120000") {
      if (entry.type === "blob" && entry.mode === "120000") skippedSymlinks += 1;
      continue;
    }
    const projectPath = toProjectPath(entry.path, root);
    if (projectPath === null) {
      return fail(
        "IMPORT_UNSAFE_PATH",
        422,
        "Repository contains an unsafe path and cannot be imported safely.",
      );
    }
    if (isExcludedPath(projectPath)) {
      skippedExcluded += 1;
      continue;
    }
    if (isBinaryExtension(projectPath)) {
      // Never fetchable as source text and never subject to size gates:
      // counted, never fetched, never fatal.
      skippedBinaries += 1;
      continue;
    }
    candidates.push({ repoPath: entry.path, projectPath, size: entry.size });
  }

  // 7. Pre-flight limits (fail fast, before any blob fetch).
  if (candidates.length > IMPORT_LIMITS.maxFiles) {
    return fail(
      "IMPORT_TOO_MANY_FILES",
      422,
      `Repository has ${candidates.length} importable files, above the import safety limit of ${IMPORT_LIMITS.maxFiles}.`,
    );
  }
  let knownBytes = 0;
  for (const c of candidates) {
    if (typeof c.size === "number") {
      if (c.size > IMPORT_LIMITS.maxFileBytes) {
        return fail(
          "IMPORT_FILE_TOO_LARGE",
          422,
          `Repository file "${c.projectPath}" exceeds the per-file import safety limit.`,
        );
      }
      knownBytes += c.size;
    }
  }
  if (knownBytes > IMPORT_LIMITS.maxTotalBytes) {
    return fail("IMPORT_TOO_LARGE", 422, "Repository exceeds the total import safety limit.");
  }

  // 8. Fetch blobs with bounded concurrency (order-preserving).
  const contents = new Array<string | null>(candidates.length).fill(null);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(IMPORT_LIMITS.fetchConcurrency, Math.max(candidates.length, 1)) },
    async () => {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        const candidate = candidates[index]!;
        const blob = await fetchFileBlob(token, owner, repo, candidate.repoPath, ref, fetchImpl);
        if (!blob.ok || !blob.bytes) {
          throw new Error(`FETCH_FAILED:${candidate.repoPath}`);
        }
        if (blob.bytes.length > IMPORT_LIMITS.maxFileBytes) {
          throw new Error("FILE_TOO_LARGE");
        }
        if (looksBinary(blob.bytes)) {
          contents[index] = null;
          continue;
        }
        const text = decodeTextBytes(blob.bytes);
        contents[index] = text;
      }
    },
  );
  try {
    await Promise.all(workers);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message === "FILE_TOO_LARGE") {
      return fail("IMPORT_FILE_TOO_LARGE", 422, "A repository file exceeds the per-file import safety limit.");
    }
    return fail(
      "GITHUB_REQUEST_FAILED",
      502,
      "Could not fetch repository files. The repository may have changed during import.",
    );
  }

  // 9. Authoritative post-decode limits over the real payload.
  // (skippedBinaries already counts extension-skipped files from step 6.)
  const files: ImportedFileRow[] = [];
  let totalBytes = 0;
  for (let i = 0; i < candidates.length; i++) {
    const text = contents[i];
    if (text === null) {
      skippedBinaries += 1;
      continue;
    }
    totalBytes += Buffer.byteLength(text, "utf8");
    files.push({ path: candidates[i]!.projectPath, content: text });
  }
  if (totalBytes > IMPORT_LIMITS.maxTotalBytes) {
    return fail("IMPORT_TOO_LARGE", 422, "Repository exceeds the total import safety limit.");
  }
  if (files.length === 0) {
    return fail("IMPORT_EMPTY", 422, "No importable files found in the selected application.");
  }

  // 10. Assemble rows for ONE atomic transaction (no writes here).
  const projectId = createId();
  const { folderRows, fileRows } = buildImportFileRows(projectId, files, userId);
  const description = meta.description ?? `Imported from ${meta.fullName}`;
  let templateVersion = "1.0.0";
  try {
    templateVersion = getManifest(template).version;
  } catch {
    templateVersion = "1.0.0";
  }
  return {
    ok: true,
    projectId,
    project: {
      name: meta.name,
      description: description.length > 500 ? description.slice(0, 500) : description,
      template,
      templateVersion,
      ownerId: userId,
    },
    gitRepository: {
      githubRepoId: String(meta.id),
      owner: meta.owner.login,
      repo: meta.name,
      fullName: meta.fullName,
      defaultBranch: meta.defaultBranch ?? "main",
      currentBranch: meta.defaultBranch ?? "main",
      importedSha: ref,
      private: meta.private,
      canRead: meta.access.canRead,
      canWrite: meta.access.canWrite,
      canAdmin: meta.access.canAdmin,
    },
    folderRows,
    fileRows,
    stats: {
      files: files.length,
      folders: folderRows.length,
      totalBytes,
      skippedExcluded,
      skippedSymlinks,
      skippedSubmodules,
      skippedBinaries,
    },
  };
}
