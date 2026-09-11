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
};
