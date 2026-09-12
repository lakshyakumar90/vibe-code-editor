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
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  truncated: boolean;
  totalCount: number;
  entries: GitStatusEntry[];
  remote: { owner: string; repo: string; fullName: string | null } | null;
}

export type RemoteCapability =
  | "LOCAL_ONLY"
  | "CONNECTED_READONLY"
  | "CONNECTED_WRITE"
  | "REMOTE_UNAVAILABLE"
  | "REAUTH_REQUIRED";

export interface RemoteState {
  capability: RemoteCapability;
  remote: { owner: string; repo: string; fullName: string | null; url: string } | null;
  permissions: { canRead: boolean; canWrite: boolean; canAdmin: boolean } | null;
  /** False for legacy imports whose original root was never recorded. */
  importRootKnown: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  remoteName?: string;
  commit: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
}

export interface BranchList {
  current: string;
  local: GitBranch[];
  remote: Array<{ name: string; remoteName: string; commit: string }>;
  remoteTruncated: boolean;
}

export interface HistoryCommit {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  parents: string[];
}

export interface HistoryPage {
  branch: string;
  commits: HistoryCommit[];
  hasMore: boolean;
}

export interface CommitDetail extends HistoryCommit {
  files: Array<{
    path: string;
    oldPath?: string;
    status: GitFileStatus;
    additions?: number;
    deletions?: number;
    binary: boolean;
  }>;
}

export interface HistoryDiff extends GitDiff {
  sha: string;
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

  async getRemote(projectId: string): Promise<RemoteState> {
    const res = await api.get<ApiResponse<RemoteState>>(
      `/api/projects/${projectId}/git/remote`,
    );
    return res.data;
  },

  async fetch(projectId: string): Promise<{ branch: string; upstream: string | null; ahead: number; behind: number; fetchedAt: string }> {
    const res = await api.post<
      ApiResponse<{ branch: string; upstream: string | null; ahead: number; behind: number; fetchedAt: string }>
    >(`/api/projects/${projectId}/git/fetch`, {});
    return res.data;
  },

  async pull(projectId: string): Promise<{ pulled: boolean; oldSha: string | null; newSha: string | null; status: GitStatus }> {
    const res = await api.post<
      ApiResponse<{ pulled: boolean; oldSha: string | null; newSha: string | null; status: GitStatus }>
    >(`/api/projects/${projectId}/git/pull`, {});
    return res.data;
  },

  async push(projectId: string, branch?: string): Promise<{
    branch: string;
    remote: string;
    pushed: boolean;
    oldSha: string | null;
    newSha: string | null;
    ahead: number;
    behind: number;
  }> {
    const res = await api.post<
      ApiResponse<{
        branch: string;
        remote: string;
        pushed: boolean;
        oldSha: string | null;
        newSha: string | null;
        ahead: number;
        behind: number;
      }>
    >(`/api/projects/${projectId}/git/push`, branch ? { branch } : {});
    return res.data;
  },

  async listBranches(projectId: string): Promise<BranchList> {
    const res = await api.get<ApiResponse<BranchList>>(
      `/api/projects/${projectId}/git/branches`,
    );
    return res.data;
  },

  async createBranch(projectId: string, name: string, from?: string): Promise<{ branch: GitBranch; from: string }> {
    const res = await api.post<ApiResponse<{ branch: GitBranch; from: string }>>(
      `/api/projects/${projectId}/git/branches`,
      from ? { name, from } : { name },
    );
    return res.data;
  },

  async checkout(projectId: string, name: string): Promise<{ branch: string; status: GitStatus }> {
    const res = await api.post<ApiResponse<{ branch: string; status: GitStatus }>>(
      `/api/projects/${projectId}/git/checkout`,
      { name },
    );
    return res.data;
  },

  async getHistory(
    projectId: string,
    params: { branch?: string; limit?: number; cursor?: string } = {},
  ): Promise<HistoryPage> {
    const search = new URLSearchParams();
    if (params.branch) search.set("branch", params.branch);
    if (params.limit) search.set("limit", String(params.limit));
    if (params.cursor) search.set("cursor", params.cursor);
    const qs = search.toString();
    const res = await api.get<ApiResponse<HistoryPage>>(
      `/api/projects/${projectId}/git/history${qs ? `?${qs}` : ""}`,
    );
    return res.data;
  },

  async getCommit(projectId: string, sha: string): Promise<CommitDetail> {
    const res = await api.get<ApiResponse<CommitDetail>>(
      `/api/projects/${projectId}/git/history/${encodeURIComponent(sha)}`,
    );
    return res.data;
  },

  async getCommitDiff(projectId: string, sha: string, path: string): Promise<HistoryDiff> {
    const res = await api.get<ApiResponse<HistoryDiff>>(
      `/api/projects/${projectId}/git/history/${encodeURIComponent(sha)}/diff?path=${encodeURIComponent(path)}`,
    );
    return res.data;
  },
};
