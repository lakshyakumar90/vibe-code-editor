import {
  detectAppRoot,
  detectRepository,
  findAppRoots,
  scopeFilesToRoot,
  type AppRootInspection,
  type TemplateDetection,
} from "@repo/templates/detect";
import {
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  GITHUB_VALIDATION_TIMEOUT_MS,
} from "./github.constants";
import { hasRepoScope } from "./github.service";
import type {
  GitHubRepoAccess,
  GitHubRepoDto,
  GitHubRepoPermissions,
  InspectedRootResult,
  RepoInspectionResponse,
  RepoMetadataResponse,
} from "./repos.types";

/** Minimal fetch shape used for GitHub calls (keeps tests mockable). */
export type GitHubFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Single GitHub API base — no arbitrary URL proxying (asserted by tests). */
const API = GITHUB_API_BASE;

/** Max tree paths retained before treating the tree as truncated. */
export const MAX_TREE_PATHS = 20_000;
/** Max candidate roots inspected per repository. */
export const MAX_INSPECT_ROOTS = 10;
/** Max decoded bytes accepted for a package.json blob. */
export const MAX_PACKAGE_JSON_BYTES = 256_000;
/** Pages fetched (in parallel) when `q` filtering is requested. */
export const SEARCH_FETCH_PAGES = 3;

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/** Strict owner/repo segment validation — blocks path traversal games. Pure. */
export function isValidRepoSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    OWNER_REPO_RE.test(value)
  );
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "vibe-code-editor",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

export interface GitHubCallResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  scopes: string | null;
  rateLimited: boolean;
}

async function callGitHub<T>(
  token: string,
  path: string,
  fetchImpl: GitHubFetch,
): Promise<GitHubCallResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method: "GET",
      headers: headers(token),
      signal: AbortSignal.timeout(GITHUB_VALIDATION_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, data: null, scopes: null, rateLimited: false };
  }
  const scopes = response.headers?.get("x-oauth-scopes") ?? null;
  const rateLimited =
    response.status === 403 && response.headers?.get("x-ratelimit-remaining") === "0";
  if (!response.ok) {
    return { ok: false, status: response.status, data: null, scopes, rateLimited };
  }
  try {
    const data = (await response.json()) as T;
    return { ok: true, status: response.status, data, scopes, rateLimited: false };
  } catch {
    return { ok: false, status: 502, data: null, scopes, rateLimited: false };
  }
}

/** True when the Link header advertises a next page. Pure. */
export function hasNextPage(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return linkHeader.split(",").some((part) => part.includes('rel="next"'));
}

function toBool(v: unknown): boolean {
  return v === true;
}

function normalizePermissions(raw: unknown): GitHubRepoPermissions {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    pull: toBool(p["pull"]),
    push: toBool(p["push"]),
    admin: toBool(p["admin"]),
    maintain: toBool(p["maintain"]),
    triage: toBool(p["triage"]),
  };
}

function toAccess(permissions: GitHubRepoPermissions): GitHubRepoAccess {
  return {
    canRead: permissions.pull || permissions.push || permissions.admin,
    canWrite: permissions.push,
    canAdmin: permissions.admin,
  };
}

/** Normalize one raw repository object to the safe DTO. Pure. */
export function normalizeRepo(raw: Record<string, unknown>): GitHubRepoDto | null {
  if (!raw || typeof raw !== "object") return null;
  const owner = (raw["owner"] ?? {}) as Record<string, unknown>;
  const name = raw["name"];
  const fullName = raw["full_name"];
  if (typeof name !== "string" || typeof fullName !== "string") return null;
  const ownerLogin = owner["login"];
  if (typeof ownerLogin !== "string") return null;
  const permissions = normalizePermissions(raw["permissions"]);
  return {
    id: (raw["id"] as number | string) ?? fullName,
    name,
    fullName,
    owner: { login: ownerLogin, type: typeof owner["type"] === "string" ? owner["type"] : "User" },
    private: toBool(raw["private"]),
    fork: toBool(raw["fork"]),
    defaultBranch: typeof raw["default_branch"] === "string" ? raw["default_branch"] : null,
    htmlUrl: typeof raw["html_url"] === "string" ? raw["html_url"] : `https://github.com/${fullName}`,
    description: typeof raw["description"] === "string" ? raw["description"] : null,
    language: typeof raw["language"] === "string" ? raw["language"] : null,
    stars: typeof raw["stargazers_count"] === "number" ? raw["stargazers_count"] : 0,
    updatedAt: typeof raw["updated_at"] === "string" ? raw["updated_at"] : null,
    permissions,
    access: toAccess(permissions),
  };
}

/** Case-insensitive name/fullName substring filter. Pure. */
export function filterReposByQuery(repos: GitHubRepoDto[], q: string): GitHubRepoDto[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return repos;
  return repos.filter(
    (r) => r.name.toLowerCase().includes(needle) || r.fullName.toLowerCase().includes(needle),
  );
}

export interface RawListResult {
  repos: GitHubRepoDto[];
  hasNextPage: boolean;
  scopes: string | null;
  error: { status: number; rateLimited: boolean } | null;
}

/**
 * List repositories via GET /user/repos (owner/collaborator/org-member).
 * 1:1 pagination; with `q`, bounded parallel fetch (SEARCH_FETCH_PAGES)
 * then application-side filtering (GitHub search lacks permission data).
 */
export async function listUserRepos(
  token: string,
  page: number,
  perPage: number,
  q: string | null,
  fetchImpl: GitHubFetch = fetch,
): Promise<RawListResult> {
  if (q) {
    const pages = await Promise.all(
      Array.from({ length: SEARCH_FETCH_PAGES }, (_, i) =>
        callGitHub<unknown[]>(
          token,
          `/user/repos?per_page=100&page=${i + 1}&sort=updated&affiliation=owner,collaborator,organization_member`,
          fetchImpl,
        ),
      ),
    );
    const failed = pages.find((p) => !p.ok);
    if (failed) {
      return {
        repos: [],
        hasNextPage: false,
        scopes: failed.scopes,
        error: { status: failed.status, rateLimited: failed.rateLimited },
      };
    }
    const all = pages
      .flatMap((p) => (Array.isArray(p.data) ? p.data : []))
      .map((r) => normalizeRepo(r as Record<string, unknown>))
      .filter((r): r is GitHubRepoDto => r !== null);
    const seen = new Set<string>();
    const deduped = all.filter((r) => (seen.has(r.fullName) ? false : (seen.add(r.fullName), true)));
    return {
      repos: filterReposByQuery(deduped, q),
      hasNextPage: false,
      scopes: pages[0]?.scopes ?? null,
      error: null,
    };
  }

  // 1:1 pagination needs the Link header: use a raw fetch here so the
  // header survives (callGitHub drops headers). Token stays server-side.
  let response: Response;
  try {
    response = await fetchImpl(
      `${API}/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      {
        method: "GET",
        headers: headers(token),
        signal: AbortSignal.timeout(GITHUB_VALIDATION_TIMEOUT_MS),
      },
    );
  } catch {
    return { repos: [], hasNextPage: false, scopes: null, error: { status: 0, rateLimited: false } };
  }
  const scopes = response.headers?.get("x-oauth-scopes") ?? null;
  if (!response.ok) {
    return {
      repos: [],
      hasNextPage: false,
      scopes,
      error: {
        status: response.status,
        rateLimited:
          response.status === 403 && response.headers?.get("x-ratelimit-remaining") === "0",
      },
    };
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { repos: [], hasNextPage: false, scopes, error: { status: 502, rateLimited: false } };
  }
  const repos = (Array.isArray(raw) ? raw : [])
    .map((r) => normalizeRepo(r as Record<string, unknown>))
    .filter((r): r is GitHubRepoDto => r !== null);
  return {
    repos,
    hasNextPage: hasNextPage(response.headers?.get("link")),
    scopes,
    error: null,
  };
}

export interface RepoDetail {
  repo: RepoMetadataResponse | null;
  scopes: string | null;
  error: { status: number; rateLimited: boolean } | null;
}

/** GET /repos/{owner}/{repo} + default-branch head SHA (best effort). */
export async function fetchRepoDetail(
  token: string,
  owner: string,
  repo: string,
  fetchImpl: GitHubFetch = fetch,
): Promise<RepoDetail> {
  const meta = await callGitHub<Record<string, unknown>>(
    token,
    `/repos/${owner}/${repo}`,
    fetchImpl,
  );
  if (!meta.ok || !meta.data) {
    return { repo: null, scopes: meta.scopes, error: { status: meta.status, rateLimited: meta.rateLimited } };
  }
  const dto = normalizeRepo(meta.data);
  if (!dto) {
    return { repo: null, scopes: meta.scopes, error: { status: 502, rateLimited: false } };
  }
  const parentRaw = (meta.data["parent"] ?? null) as Record<string, unknown> | null;
  const parent =
    dto.fork && parentRaw && typeof parentRaw["full_name"] === "string"
      ? {
          fullName: parentRaw["full_name"] as string,
          htmlUrl:
            typeof parentRaw["html_url"] === "string"
              ? (parentRaw["html_url"] as string)
              : `https://github.com/${parentRaw["full_name"]}`,
        }
      : null;

  let latestSha: string | null = null;
  if (dto.defaultBranch) {
    const commits = await callGitHub<Array<{ sha?: unknown }>>(
      token,
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(dto.defaultBranch)}?per_page=1`,
      fetchImpl,
    );
    const sha = commits.ok && Array.isArray(commits.data) ? commits.data[0]?.sha : null;
    latestSha = typeof sha === "string" ? sha : null;
  }

  return { repo: { ...dto, parent, latestSha }, scopes: meta.scopes, error: null };
}

export interface TreeResult {
  truncated: boolean;
  paths: string[];
  error: { status: number; rateLimited: boolean } | null;
}

/** Recursive tree (blobs+trees only); overflow beyond cap => truncated. */
export async function fetchRepoTree(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: GitHubFetch = fetch,
): Promise<TreeResult> {
  const tree = await callGitHub<{ truncated?: unknown; tree?: unknown }>(
    token,
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    fetchImpl,
  );
  if (!tree.ok || !tree.data) {
    return { truncated: false, paths: [], error: { status: tree.status, rateLimited: tree.rateLimited } };
  }
  const entries = Array.isArray(tree.data.tree) ? tree.data.tree : [];
  const paths: string[] = [];
  for (const entry of entries) {
    const e = entry as Record<string, unknown>;
    if (e["type"] !== "blob" && e["type"] !== "tree") continue;
    if (typeof e["path"] !== "string") continue;
    paths.push(e["path"] as string);
    if (paths.length > MAX_TREE_PATHS) {
      return { truncated: true, paths: [], error: null };
    }
  }
  if (tree.data.truncated === true) {
    return { truncated: true, paths: [], error: null };
  }
  return { truncated: false, paths, error: null };
}

export interface TreeEntry {
  path: string;
  /** Tree entry type: "blob" | "tree" | "commit" (submodule) | other. */
  type: string;
  /** Git mode, e.g. "100644" file, "120000" symlink, "160000" submodule. */
  mode: string;
  /** Blob/tree SHA (absent for some entries). */
  sha: string | null;
  /** Blob size in bytes when reported. */
  size: number | null;
}

export interface TreeEntriesResult {
  truncated: boolean;
  entries: TreeEntry[];
  error: { status: number; rateLimited: boolean } | null;
}

/**
 * Recursive tree with full entry metadata (mode/type/sha/size).
 * Same truncation policy as fetchRepoTree. Additive — fetchRepoTree untouched.
 */
export async function fetchRepoTreeEntries(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: GitHubFetch = fetch,
): Promise<TreeEntriesResult> {
  const tree = await callGitHub<{ truncated?: unknown; tree?: unknown }>(
    token,
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    fetchImpl,
  );
  if (!tree.ok || !tree.data) {
    return { truncated: false, entries: [], error: { status: tree.status, rateLimited: tree.rateLimited } };
  }
  const rawEntries = Array.isArray(tree.data.tree) ? tree.data.tree : [];
  const entries: TreeEntry[] = [];
  for (const entry of rawEntries) {
    const e = entry as Record<string, unknown>;
    if (typeof e["path"] !== "string") continue;
    entries.push({
      path: e["path"] as string,
      type: typeof e["type"] === "string" ? (e["type"] as string) : "",
      mode: typeof e["mode"] === "string" ? (e["mode"] as string) : "",
      sha: typeof e["sha"] === "string" ? (e["sha"] as string) : null,
      size: typeof e["size"] === "number" ? (e["size"] as number) : null,
    });
    if (entries.length > MAX_TREE_PATHS) {
      return { truncated: true, entries: [], error: null };
    }
  }
  if (tree.data.truncated === true) {
    return { truncated: true, entries: [], error: null };
  }
  return { truncated: false, entries, error: null };
}

export interface FileBlobResult {
  ok: boolean;
  /** Decoded bytes when ok. */
  bytes: Buffer | null;
  /** True when the entry exists but cannot be fetched as a blob. */
  notFound: boolean;
}

/**
 * Fetch + base64-decode one file via Contents API (server-derived path).
 * Returns raw bytes — text/binary classification happens in import.service.
 */
export async function fetchFileBlob(
  token: string,
  owner: string,
  repo: string,
  repoPath: string,
  ref: string,
  fetchImpl: GitHubFetch = fetch,
): Promise<FileBlobResult> {
  const encoded = repoPath.split("/").map(encodeURIComponent).join("/");
  const blob = await callGitHub<{ content?: unknown; encoding?: unknown; size?: unknown }>(
    token,
    `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    fetchImpl,
  );
  if (!blob.ok || !blob.data) return { ok: false, bytes: null, notFound: blob.status === 404 };
  if (blob.data.encoding !== "base64" || typeof blob.data.content !== "string") {
    return { ok: false, bytes: null, notFound: false };
  }
  try {
    const bytes = Buffer.from(blob.data.content.replace(/\s/g, ""), "base64");
    return { ok: true, bytes, notFound: false };
  } catch {
    return { ok: false, bytes: null, notFound: false };
  }
}

/** Fetch + decode one package.json via Contents API (server-derived path). */
export async function fetchPackageJson(
  token: string,
  owner: string,
  repo: string,
  dir: string,
  ref: string,
  fetchImpl: GitHubFetch = fetch,
): Promise<AppRootInspection["packageJson"]> {
  const rel = dir === "" ? "package.json" : `${dir}/package.json`;
  const encoded = rel.split("/").map(encodeURIComponent).join("/");
  const blob = await callGitHub<{ content?: unknown; encoding?: unknown; size?: unknown }>(
    token,
    `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    fetchImpl,
  );
  if (!blob.ok || !blob.data) return null;
  if (blob.data.encoding !== "base64" || typeof blob.data.content !== "string") return null;
  if (typeof blob.data.size === "number" && blob.data.size > MAX_PACKAGE_JSON_BYTES) return null;
  try {
    const text = Buffer.from(blob.data.content.replace(/\s/g, ""), "base64").toString("utf8");
    if (text.length > MAX_PACKAGE_JSON_BYTES) return null;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const pick = (v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : undefined;
    return {
      dependencies: pick(parsed["dependencies"]),
      devDependencies: pick(parsed["devDependencies"]),
      peerDependencies: pick(parsed["peerDependencies"]),
      scripts: pick(parsed["scripts"]),
    };
  } catch {
    return null;
  }
}

export interface InspectionBuild {
  response: RepoInspectionResponse;
}

/**
 * Assemble detection input from a tree and run the pure detector.
 * Truncated/oversized input can never yield SUPPORTED (detector enforces).
 */
export async function inspectRepository(
  token: string,
  owner: string,
  repo: string,
  fullName: string,
  defaultBranch: string | null,
  ref: string,
  tree: TreeResult,
  fetchImpl: GitHubFetch = fetch,
): Promise<InspectionBuild> {
  const roots = findAppRoots(tree.paths).slice(0, MAX_INSPECT_ROOTS + 1);
  const overflowRoots = roots.length > MAX_INSPECT_ROOTS;
  const useRoots = overflowRoots ? [] : roots;

  let detection: TemplateDetection;
  const inspected: InspectedRootResult[] = [];
  if (tree.truncated || overflowRoots) {
    detection = {
      kind: "unsupported",
      truncated: true,
      reasons: [
        tree.truncated
          ? "inspection incomplete: GitHub recursive tree is truncated (repository too large); refusing to classify without full evidence"
          : `inspection incomplete: more than ${MAX_INSPECT_ROOTS} application roots; refusing to classify`,
      ],
    };
  } else {
    // A lone repo-root application owns the whole tree: scoping to
    // top-level/config files would hide its nested entry structure
    // (e.g. src/App.vue) and mis-detect it. Multi-root repos keep
    // per-root scoping so sibling apps never leak into each other.
    const soloRepoRoot = useRoots.length === 1 && useRoots[0] === "";
    const built: AppRootInspection[] = [];
    for (const root of useRoots) {
      const packageJson = await fetchPackageJson(token, owner, repo, root, ref, fetchImpl);
      // Unreadable package.json => root stays unknown (conservative: it
      // cannot contribute a SUPPORTED verdict).
      built.push({
        root,
        files: soloRepoRoot ? tree.paths : scopeFilesToRoot(tree.paths, root),
        packageJson,
      });
    }
    detection = detectRepository({ roots: built, truncated: false });
    for (const b of built) {
      inspected.push({ root: b.root, detection: detectAppRoot(b) });
    }
  }

  return {
    response: {
      owner,
      repo,
      fullName,
      defaultBranch,
      sha: ref,
      truncated: tree.truncated || overflowRoots,
      treeCount: tree.paths.length,
      roots: inspected,
      detection,
    },
  };
}

/** Granted repo access from scopes (authoritative header preferred). Pure. */
export function grantedRepoAccess(scopes: string | null, storedScope: string | null): boolean {
  return hasRepoScope(scopes ?? storedScope);
}
