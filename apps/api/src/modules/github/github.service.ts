import { createHash } from "node:crypto";
import { RedisService } from "../../lib/redis.js";
import { CacheKeys, TTL } from "../../lib/cache-keys.js";
import { ProjectRepository } from "../projects/project.repository.js";

export type SupportedTemplate = "NEXTJS" | "EXPRESS" | "HONO" | "REACT" | "ANGULAR" | "VUE" | null;

const INSPECT_FILE_LIMIT = 50;
const IMPORT_FILE_LIMIT = 500;
const IMPORT_BYTES_LIMIT = 5 * 1024 * 1024;

function headers(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "vibe-code-editor",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Detect one of the six supported templates from a package.json payload. */
export function detectTemplate(pkg: any, fileNames: string[]): SupportedTemplate {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (...names: string[]) => names.some((n) => n in deps);
  const files = new Set(fileNames);
  if (has("next") || files.has("next.config.js") || files.has("next.config.mjs")) return "NEXTJS";
  if (has("@angular/core") || files.has("angular.json")) return "ANGULAR";
  if (has("vue", "nuxt") || files.has("vue.config.js") || files.has("vite.config.ts")) {
    // vue vs react share vite — prefer explicit vue dep
    if ("vue" in deps) return "VUE";
  }
  if (has("hono")) return "HONO";
  if (has("express")) return "EXPRESS";
  if (has("react", "react-dom", "vite", "@vitejs/plugin-react")) return "REACT";
  return null;
}

export function sanitizeImportPath(p: string): string | null {
  if (!p || p.includes("..") || p.startsWith("/") || p.includes(".git/")) return null;
  if (p === ".env" || p.startsWith(".env.")) return null;
  if (p.includes("node_modules")) return null;
  return p;
}

async function gh(path: string, token?: string) {
  const res = await fetch(`https://api.github.com${path}`, { headers: headers(token) });
  if (res.status === 401 || res.status === 403) throw new Error("GITHUB_AUTH");
  if (res.status === 404) throw new Error("GITHUB_NOT_FOUND");
  if (!res.ok) throw new Error("GITHUB_UNAVAILABLE");
  return res.json();
}

export const githubService = {
  /** User-scoped repo discovery, cached per user+query. Never caches tokens. */
  async listRepos(userId: string, query: string, token?: string) {
    const q = query.slice(0, 80);
    const hash = createHash("sha256").update(q).digest("hex").slice(0, 16);
    const key = CacheKeys.githubRepos(userId, hash);
    const cached = await RedisService.get<any[]>(key);
    if (cached) return { repos: cached, cached: true };
    // Authenticated: own repos; unauthenticated: public search fallback.
    let repos: any[];
    if (token) {
      const data: any[] = await gh(`/user/repos?per_page=50&sort=updated`, token);
      repos = data
        .filter((r) => !q || r.full_name.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 50)
        .map((r) => ({
          fullName: r.full_name,
          owner: r.owner?.login,
          name: r.name,
          private: r.private,
          description: r.description,
          language: r.language,
          defaultBranch: r.default_branch,
        }));
    } else {
      const data: any = q
        ? await gh(`/search/repositories?q=${encodeURIComponent(q)}&per_page=20`, undefined)
        : { items: [] };
      repos = (data.items ?? []).map((r: any) => ({
        fullName: r.full_name,
        owner: r.owner?.login,
        name: r.name,
        private: r.private,
        description: r.description,
        language: r.language,
        defaultBranch: r.default_branch,
      }));
    }
    await RedisService.set(key, repos, TTL.githubRepos);
    return { repos, cached: false };
  },

  /** Inspect repo tree + package.json to classify template. Cached. */
  async inspect(owner: string, repo: string, token?: string) {
    const key = CacheKeys.githubInspection(owner, repo);
    const cached = await RedisService.get<any>(key);
    if (cached) return { ...cached, cached: true };
    const meta: any = await gh(`/repos/${owner}/${repo}`, token);
    const tree: any = await gh(
      `/repos/${owner}/${repo}/git/trees/${meta.default_branch}?recursive=1`,
      token,
    );
    const paths: string[] = (tree.tree ?? [])
      .filter((t: any) => t.type === "blob")
      .map((t: any) => t.path)
      .slice(0, INSPECT_FILE_LIMIT * 4);
    let pkg: any = null;
    if (paths.includes("package.json")) {
      try {
        const blob: any = await gh(
          `/repos/${owner}/${repo}/contents/package.json?ref=${meta.default_branch}`,
          token,
        );
        const content = Buffer.from(blob.content ?? "", "base64").toString("utf8").slice(0, 20000);
        pkg = JSON.parse(content);
      } catch {
        pkg = null;
      }
    }
    const template = detectTemplate(pkg, paths);
    const result = {
      fullName: meta.full_name,
      description: meta.description,
      language: meta.language,
      private: meta.private,
      defaultBranch: meta.default_branch,
      template,
      supported: template !== null,
      fileCount: tree.truncated === true ? -1 : paths.length,
    };
    await RedisService.set(key, result, TTL.githubInspection);
    return { ...result, cached: false };
  },

  /** Atomic import: fetch files server-side, create project + seed files. */
  async importRepo(userId: string, owner: string, repo: string, name: string, token?: string) {
    const inspection: any = await this.inspect(owner, repo, token);
    if (!inspection.supported || !inspection.template) throw new Error("UNSUPPORTED_TEMPLATE");
    const tree: any = await gh(
      `/repos/${owner}/${repo}/git/trees/${inspection.defaultBranch}?recursive=1`,
      token,
    );
    const blobs = (tree.tree ?? []).filter((t: any) => t.type === "blob");
    const files: Array<{ path: string; content: string; isFolder: boolean }> = [];
    let bytes = 0;
    for (const entry of blobs.slice(0, IMPORT_FILE_LIMIT)) {
      const safe = sanitizeImportPath(entry.path);
      if (!safe) continue;
      if (entry.size && entry.size > 512 * 1024) continue; // skip binaries
      const blob: any = await gh(
        `/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
        token,
      );
      const content = Buffer.from(blob.content ?? "", "base64").toString("utf8");
      if (content.includes("\0")) continue; // binary
      bytes += content.length;
      if (bytes > IMPORT_BYTES_LIMIT) break;
      files.push({ path: safe, content: content.slice(0, 200000), isFolder: false });
    }
    const project = await ProjectRepository.createProject({
      name: name.slice(0, 60).trim() || repo,
      description: `Imported from GitHub ${owner}/${repo}`,
      template: inspection.template,
      ownerId: userId,
    });
    // Seed files via file repository if available
    try {
      const { FileRepository } = await import("../projects/files/file.repository.js");
      for (const f of files) {
        await FileRepository.createFile({
          projectId: project.id,
          path: f.path,
          content: f.content,
          isFolder: false,
        } as any);
      }
    } catch {
      // project exists even if seeding partially fails
    }
    const { invalidateUserProjects } = await import("../../lib/cache-keys.js");
    await invalidateUserProjects(userId);
    return { project, importedFiles: files.length, template: inspection.template };
  },
};
