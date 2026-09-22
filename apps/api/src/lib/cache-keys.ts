import { RedisService } from "./redis.js";

export const CacheKeys = {
  userProjects: (userId: string) => `dashboard:user:${userId}:projects`,
  projectSummary: (projectId: string) => `project:${projectId}:summary`,
  templatesCatalog: () => `templates:catalog`,
  githubRepos: (userId: string, queryHash: string) => `github:repos:${userId}:${queryHash}`,
  githubInspection: (owner: string, repo: string) => `github:repo:${owner}:${repo}:inspection`,
  githubStatus: (userId: string) => `github:user:${userId}:status`,
  userProfile: (userId: string) => `user:${userId}:profile`,
};

export const TTL = {
  projects: 120,
  projectSummary: 120,
  templates: 3600,
  githubRepos: 300,
  githubInspection: 600,
  githubStatus: 300,
  profile: 300,
};

export async function invalidateUserProjects(userId: string) {
  await RedisService.invalidate([
    CacheKeys.userProjects(userId),
    `dashboard:user:${userId}:starred`,
    `dashboard:user:${userId}:recent`,
  ]);
}

export async function invalidateProject(projectId: string, ownerId?: string) {
  await RedisService.delete(CacheKeys.projectSummary(projectId));
  if (ownerId) await invalidateUserProjects(ownerId);
}

export async function invalidateUserProfile(userId: string) {
  await RedisService.delete(CacheKeys.userProfile(userId));
}

export async function invalidateGithubRepos(userId: string) {
  await RedisService.invalidate([`github:repos:${userId}:*`, CacheKeys.githubStatus(userId)]);
}

export async function invalidateGithubInspection(owner: string, repo: string) {
  await RedisService.delete(CacheKeys.githubInspection(owner, repo));
}
