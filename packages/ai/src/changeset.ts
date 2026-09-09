import type { ChangeSetInput, FileChange, PlanTask } from "./types";

/**
 * Changeset validation + diff computation (pure — no prisma).
 * Built for the stored-pending contract: validate a persisted pending
 * changeset the same way it was validated at creation (re-validated on
 * apply against live file state). Never applies anything itself.
 */

export const MAX_CHANGESET_FILES = 20;
export const MAX_FILE_BYTES = 200_000;

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  normalized?: ChangeSetInput;
}

export interface ExistingState {
  existingPaths: Set<string>;
  existingFolders: Set<string>;
}

function normalizePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p) return null;
  const parts = p.split("/");
  if (parts.some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  const lowered = p.toLowerCase();
  if (
    lowered === "node_modules" ||
    lowered.startsWith("node_modules/") ||
    lowered === ".git" ||
    lowered.startsWith(".git/")
  ) {
    return null;
  }
  return parts.join("/");
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function validateChangeSet(
  input: unknown,
  state: ExistingState,
): ValidationResult {
  const errors: ValidationError[] = [];
  const changes = (input as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes)) {
    return {
      valid: false,
      errors: [{ path: "changes", message: "changes must be an array" }],
    };
  }
  if (changes.length === 0 || changes.length > MAX_CHANGESET_FILES) {
    return {
      valid: false,
      errors: [
        {
          path: "changes",
          message: `changes must have 1–${MAX_CHANGESET_FILES} entries`,
        },
      ],
    };
  }

  const normalized: FileChange[] = [];
  const seen = new Set<string>();
  // Folders created by this changeset satisfy parent checks regardless
  // of entry order (pre-scan; each folder entry is still validated below).
  const createdFolders = new Set<string>();
  for (const raw of changes) {
    const entry = raw as Partial<FileChange> | null;
    const path = normalizePath(entry?.path);
    if (path && entry?.isFolder === true && entry?.delete !== true) {
      createdFolders.add(path);
    }
  }

  changes.forEach((raw, i) => {
    const at = `changes[${i}]`;
    const entry = raw as Partial<FileChange> | null;
    const path = normalizePath(entry?.path);
    if (!path) {
      errors.push({
        path: `${at}.path`,
        message: "path must be a relative posix path without .., node_modules, or .git",
      });
      return;
    }
    if (seen.has(path)) {
      errors.push({ path: `${at}.path`, message: `duplicate path "${path}"` });
      return;
    }
    seen.add(path);

    const del = entry?.delete === true;
    const content = entry?.content ?? null;
    const isFolder = entry?.isFolder === true;
    const existsAsFile = state.existingPaths.has(path);
    const existsAsFolder = state.existingFolders.has(path);

    if (isFolder && content !== null) {
      errors.push({
        path: `${at}.content`,
        message: "folder changes must have null content",
      });
      return;
    }

    if (del) {
      if (!existsAsFile && !existsAsFolder) {
        errors.push({
          path: `${at}.path`,
          message: `cannot delete "${path}": nothing exists there`,
        });
        return;
      }
      if (existsAsFile && existsAsFolder) {
        errors.push({
          path: `${at}.path`,
          message: `cannot delete "${path}": ambiguous (set isFolder to choose)`,
        });
        return;
      }
      // Deleting a folder removes it with all descendants.
      normalized.push({ path, content: null, delete: true, ...(existsAsFolder ? { isFolder: true as const } : {}) });
      return;
    }

    if (isFolder) {
      if (existsAsFile) {
        errors.push({
          path: `${at}.path`,
          message: `cannot create folder "${path}": a file exists there`,
        });
        return;
      }
      if (existsAsFolder) {
        // Idempotent no-op (still recorded so apply can skip safely).
        normalized.push({ path, content: null, isFolder: true });
        return;
      }
      const parent = parentDir(path);
      if (parent !== "" && !state.existingFolders.has(parent) && !createdFolders.has(parent)) {
        errors.push({
          path: `${at}.path`,
          message: `parent folder "${parent}" does not exist (create it in the same changeset first)`,
        });
        return;
      }
      createdFolders.add(path);
      normalized.push({ path, content: null, isFolder: true });
      return;
    }

    if (typeof content !== "string") {
      errors.push({
        path: `${at}.content`,
        message: "content must be a string (or use delete: true)",
      });
      return;
    }
    if (content.length > MAX_FILE_BYTES) {
      errors.push({
        path: `${at}.content`,
        message: `content exceeds ${MAX_FILE_BYTES} bytes`,
      });
      return;
    }
    if (existsAsFolder) {
      errors.push({
        path: `${at}.path`,
        message: `cannot write file "${path}": a folder exists there`,
      });
      return;
    }
    // New files may land under existing folders or folders created
    // earlier in the same changeset (order-independent).
    const parent = parentDir(path);
    if (parent !== "" && !state.existingFolders.has(parent) && !createdFolders.has(parent)) {
      errors.push({
        path: `${at}.path`,
        message: `parent folder "${parent}" does not exist (create it in the same changeset first)`,
      });
      return;
    }
    normalized.push({ path, content });
  });

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], normalized: { changes: normalized } };
}

export interface FileDiff {
  path: string;
  oldContent: string | null;
  newContent: string | null;
  deleted: boolean;
  isFolder: boolean;
}

/** Per-file old/new pairs for the review UI (GET /changeset/:id). */
export async function computeDiffs(
  changes: FileChange[],
  readFile: (path: string) => Promise<string | null>,
  statFile?: (path: string) => Promise<{ exists: boolean; isFolder: boolean } | null>,
): Promise<FileDiff[]> {
  const out: FileDiff[] = [];
  for (const change of changes) {
    const oldContent = await readFile(change.path);
    let isFolder = change.isFolder === true;
    if (statFile) {
      const stat = await statFile(change.path).catch(() => null);
      if (stat) isFolder = stat.isFolder;
    }
    out.push({
      path: change.path,
      oldContent,
      newContent: change.delete === true ? null : (change.content ?? ""),
      deleted: change.delete === true,
      isFolder,
    });
  }
  return out;
}

/** Extract the first ```<label> fenced JSON block from model text. */
export function extractFencedJson<T = unknown>(text: string, label: string): T | null {
  const fence = new RegExp("```" + label + "\\s*\\n([\\s\\S]*?)```", "i");
  const match = fence.exec(text);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1].trim()) as T;
  } catch {
    return null;
  }
}

/** Extract a changeset from agent output (```changeset preferred, ```json fallback). */
export function extractChangeSet(text: string): ChangeSetInput | null {
  const direct = extractFencedJson<ChangeSetInput>(text, "changeset");
  if (direct && Array.isArray(direct.changes)) return direct;
  const generic = extractFencedJson<{ changes?: unknown }>(text, "json");
  if (generic && Array.isArray(generic.changes)) {
    return { changes: generic.changes as FileChange[] };
  }
  // Tolerate a missing closing fence when the JSON itself is complete
  // (model forgot the trailing ```). Truly truncated JSON still fails —
  // the orchestrator retries those with a re-emit nudge.
  const unclosed = extractUnclosedChangeSet(text, "changeset") ?? extractUnclosedChangeSet(text, "json");
  if (unclosed) return unclosed;
  return null;
}

/**
 * Parse JSON after a ```<label> opener with no closing fence. Tries the
 * whole tail, then progressively the tail cut at the last `}` (trailing
 * prose after complete JSON). Returns null when nothing parses.
 */
export function extractUnclosedChangeSet(text: string, label: string): ChangeSetInput | null {
  const open = new RegExp("```" + label + "\\s*\\n([\\s\\S]*)$", "i").exec(text);
  const tail = open?.[1]?.trim();
  if (!tail || /```/.test(tail)) return null; // closed or not actually unclosed
  const attempts: string[] = [tail];
  let idx = tail.lastIndexOf("}");
  while (idx !== -1 && attempts.length < 4) {
    const cut = tail.slice(0, idx + 1);
    if (!attempts.includes(cut)) attempts.push(cut);
    idx = tail.lastIndexOf("}", idx - 1);
  }
  for (const raw of attempts) {
    try {
      const parsed = JSON.parse(raw) as { changes?: unknown };
      if (parsed && Array.isArray(parsed.changes)) {
        return { changes: parsed.changes as FileChange[] };
      }
      return null; // parsed but not a changeset — don't keep guessing
    } catch {
      continue;
    }
  }
  return null;
}

/** Extract + normalize a plan checklist from plan-mode output. */
export function extractPlan(text: string): PlanTask[] | null {
  const raw = extractFencedJson<Array<{ title?: unknown; status?: unknown }>>(text, "plan");
  if (!raw) return null;
  const tasks: PlanTask[] = [];
  for (const item of raw) {
    if (typeof item?.title !== "string" || !item.title.trim()) continue;
    const status =
      item.status === "complete" || item.status === "in_progress"
        ? item.status
        : "pending";
    tasks.push({ title: item.title.trim(), status });
    if (tasks.length >= 20) break;
  }
  return tasks.length > 0 ? tasks : null;
}
