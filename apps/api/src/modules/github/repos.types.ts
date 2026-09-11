/**
 * Phase 2 — repository discovery DTOs. Safe normalized shapes only;
 * never credentials, never raw GitHub payloads.
 */

export interface GitHubRepoPermissions {
  pull: boolean;
  push: boolean;
  admin: boolean;
  maintain: boolean;
  triage: boolean;
}

export interface GitHubRepoAccess {
  /** Readable (any listed repository the token can see). */
  canRead: boolean;
  /** Contents write / future push + branch operations. */
  canWrite: boolean;
  /** Admin / future merge settings. */
  canAdmin: boolean;
}

export interface GitHubRepoDto {
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
  permissions: GitHubRepoPermissions;
  /** Normalized from GitHub permissions; GitHub stays authoritative. */
  access: GitHubRepoAccess;
}

export interface RepoListMeta {
  page: number;
  perPage: number;
  hasNextPage: boolean;
  /** True when `q` triggered bounded multi-page fetch + filtering. */
  filtered: boolean;
  /** Whether the granted OAuth scopes include repository access. */
  grantedRepoAccess: boolean;
}

export interface RepoListResponse {
  repos: GitHubRepoDto[];
  meta: RepoListMeta;
}

export interface RepoMetadataResponse extends GitHubRepoDto {
  parent: { fullName: string; htmlUrl: string } | null;
  /** Default-branch head SHA (null when lookup failed; non-fatal). */
  latestSha: string | null;
}

export interface InspectedRootResult {
  root: string;
  detection: import("@repo/templates/detect").TemplateDetection;
}

export interface RepoInspectionResponse {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string | null;
  sha: string | null;
  truncated: boolean;
  treeCount: number;
  roots: InspectedRootResult[];
  detection: import("@repo/templates/detect").TemplateDetection;
}
