import { api } from "@/lib/api";

/**
 * Phase 4A — Source Control API client.
 * No remote operations exist (no push/pull/fetch/branch routes by design).
 */

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export interface GitStatusEntry {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatus {
  branch: string;
  clean: boolean;
  truncated: boolean;
  totalCount: number;
  entries: GitStatusEntry[];
}

export interface GitDiff {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  staged: boolean;
  isBinary: boolean;
  tooLarge: boolean;
  oldContent: string | null;
  newContent: string | null;
}

export interface GitCommit {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  changedFiles: string[];
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export function gitErrorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

export const gitService = {
  async ensure(projectId: string) {
    const res = await api.post<
      ApiResponse<{ bootstrapped: boolean; branch: string; head: string | null }>
    >(`/api/projects/${projectId}/git/ensure`, {});
    return res.data;
  },

  async getStatus(projectId: string): Promise<GitStatus> {
    const res = await api.get<ApiResponse<GitStatus>>(
      `/api/projects/${projectId}/git/status`,
    );
    return res.data;
  },

  async getDiff(projectId: string, path: string, staged: boolean): Promise<GitDiff> {
    const res = await api.get<ApiResponse<GitDiff>>(
      `/api/projects/${projectId}/git/diff?path=${encodeURIComponent(path)}&staged=${staged ? "true" : "false"}`,
    );
    return res.data;
  },

  async stage(projectId: string, paths: string[]): Promise<GitStatus> {
    const res = await api.post<ApiResponse<GitStatus>>(
      `/api/projects/${projectId}/git/stage`,
      { paths },
    );
    return res.data;
  },

  async unstage(projectId: string, paths: string[]): Promise<GitStatus> {
    const res = await api.post<ApiResponse<GitStatus>>(
      `/api/projects/${projectId}/git/unstage`,
      { paths },
    );
    return res.data;
  },

  async stageAll(projectId: string): Promise<GitStatus> {
    const res = await api.post<ApiResponse<GitStatus>>(
      `/api/projects/${projectId}/git/stage-all`,
      {},
    );
    return res.data;
  },

  async unstageAll(projectId: string): Promise<GitStatus> {
    const res = await api.post<ApiResponse<GitStatus>>(
      `/api/projects/${projectId}/git/unstage-all`,
      {},
    );
    return res.data;
  },

  async discard(
    projectId: string,
    paths: string[],
  ): Promise<{ restored: string[]; removed: string[]; status: GitStatus }> {
    const res = await api.post<
      ApiResponse<{ restored: string[]; removed: string[]; status: GitStatus }>
    >(`/api/projects/${projectId}/git/discard`, { paths });
    return res.data;
  },

  async commit(
    projectId: string,
    message: string,
  ): Promise<{ commit: GitCommit; status: GitStatus }> {
    const res = await api.post<ApiResponse<{ commit: GitCommit; status: GitStatus }>>(
      `/api/projects/${projectId}/git/commit`,
      { message },
    );
    return res.data;
  },
};
