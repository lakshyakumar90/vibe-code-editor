import type { TemplateDetection, TemplateId } from "@repo/templates/detect";
import { api } from "@/lib/api";

export interface GitHubUserInfo {
  id: string;
  login: string;
  avatarUrl: string | null;
  name: string | null;
  email: string | null;
}

export interface GitHubStatus {
  connected: boolean;
  githubUser: GitHubUserInfo | null;
  authorization: {
    usable: boolean;
    needsReconnect: boolean;
    reason: "not_connected" | "insufficient_scope" | "revoked" | null;
    capabilities: {
      repositoryRead: boolean;
      repositoryWrite: boolean;
      pullRequest: boolean;
    };
  };
  connection: {
    status: string;
    connectedAt: string;
    lastValidatedAt: string;
  } | null;
}

export interface GitHubRepo {
  id: number | string;
  name: string;
  fullName: string;
  owner: { login: string; type: string };
  private: boolean;
  fork: boolean;
  defaultBranch: string | null;
  htmlUrl: string;
  description: string | null;
  language: string | null;
  stars: number;
  updatedAt: string | null;
  permissions: { pull: boolean; push: boolean; admin: boolean; maintain: boolean; triage: boolean };
  access: { canRead: boolean; canWrite: boolean; canAdmin: boolean };
}

export interface RepoListMeta {
  page: number;
  perPage: number;
  hasNextPage: boolean;
  filtered: boolean;
  grantedRepoAccess: boolean;
}

export interface RepoInspection {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string | null;
  sha: string | null;
  truncated: boolean;
  treeCount: number;
  roots: { root: string; detection: TemplateDetection }[];
  detection: TemplateDetection;
}

export type { TemplateDetection, TemplateId };

interface ApiResponse<T> {
  success: boolean;
  data: T;
  code?: string;
  message?: string;
}

export const githubService = {
  async getStatus(): Promise<GitHubStatus> {
    const response = await api.get<ApiResponse<GitHubStatus>>("/api/github/status");
    return response.data;
  },

  async finalizeConnect(): Promise<GitHubStatus> {
    const response = await api.post<ApiResponse<GitHubStatus>>("/api/github/connect", {});
    return response.data;
  },

  async disconnect(): Promise<void> {
    await api.post<ApiResponse<{ disconnected: boolean }>>("/api/github/disconnect", {});
  },

  async listRepos(params: { page?: number; perPage?: number; q?: string } = {}): Promise<{
    repos: GitHubRepo[];
    meta: RepoListMeta;
  }> {
    const search = new URLSearchParams();
    if (params.page) search.set("page", String(params.page));
    if (params.perPage) search.set("perPage", String(params.perPage));
    if (params.q?.trim()) search.set("q", params.q.trim());
    const qs = search.toString();
    const response = await api.get<
      ApiResponse<{ repos: GitHubRepo[]; meta: RepoListMeta }>
    >(`/api/github/repos${qs ? `?${qs}` : ""}`);
    return response.data;
  },

  async getInspection(owner: string, repo: string): Promise<RepoInspection> {
    const response = await api.get<ApiResponse<RepoInspection>>(
      `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/inspection`,
    );
    return response.data;
  },

  async importRepo(input: {
    owner: string;
    repo: string;
    root?: string;
  }): Promise<ImportedProject> {
    const response = await api.post<ApiResponse<ImportedProject>>(
      "/api/github/import",
      input.root ? { owner: input.owner, repo: input.repo, root: input.root } : { owner: input.owner, repo: input.repo },
    );
    return response.data;
  },
};

export interface ImportedProject {
  project: {
    id: string;
    name: string;
    description: string | null;
    template: string;
    templateVersion: string;
    ownerId: string;
    createdAt: string;
    updatedAt: string;
  };
  gitRepository: {
    id: string;
    projectId: string;
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
    createdAt: string;
    updatedAt: string;
  };
  stats: {
    files: number;
    folders: number;
    totalBytes: number;
    skippedExcluded: number;
    skippedSymlinks: number;
    skippedSubmodules: number;
    skippedBinaries: number;
  };
}
