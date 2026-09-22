import { ProjectRole } from "@repo/db";
import type { CreateProjectInput, UpdateProjectInput } from "./project.types";
import { ProjectRepository } from "./project.repository";
import { RedisService } from "../../lib/redis.js";
import {
  CacheKeys,
  TTL,
  invalidateProject,
  invalidateUserProjects,
} from "../../lib/cache-keys.js";

export const projectService = {
  async createProject(
    userId: string,
    input: CreateProjectInput
  ) {
    const project = await ProjectRepository.createProject({
      name: input.name,
      description: input.description,
      template: input.template,
      ownerId: userId,
      memberIds: input.memberIds,
    });
    await invalidateUserProjects(userId);

    return project;
  },

  async getAllProjectsForUser(userId: string) {
    return RedisService.getOrSet(CacheKeys.userProjects(userId), TTL.projects, () =>
      ProjectRepository.getAllProjectsForUser(userId),
    );
  },

  async getProjectById(projectId: string, userId?: string) {
    return RedisService.getOrSet(CacheKeys.projectSummary(projectId), TTL.projectSummary, () =>
      ProjectRepository.getProjectById(projectId, userId),
    );
  },

  async toggleFavorite(projectId: string, userId: string) {
    const r = await ProjectRepository.toggleFavorite(projectId, userId);
    await invalidateProject(projectId, userId);
    return r;
  },

  async updateProject(projectId: string, input: UpdateProjectInput) {
    const r = await ProjectRepository.updateProject(projectId, input);
    await RedisService.delete(CacheKeys.projectSummary(projectId));
    return r;
  },

  async deleteProject(projectId: string) {
    const r = await ProjectRepository.deleteProject(projectId);
    await RedisService.delete(CacheKeys.projectSummary(projectId));
    return r;
  },

  async addMemberToProject(projectId: string, email: string, role: ProjectRole) {
    const user = await ProjectRepository.getUserByEmail(email);

    if (!user) {
      throw new Error(`User with email ${email} not found`);
    }

    const existingMembership = await ProjectRepository.getMembership(projectId, user.id);
    
    if (existingMembership) {
      throw new Error(`User with email ${email} is already a member of the project`);
    }

    return ProjectRepository.createMember(projectId, user.id, role);
  },

  async getMembership(projectId: string, userId: string) {
    return ProjectRepository.getMembership(projectId, userId);
  },

  async getUserByEmail(email: string) {
    return ProjectRepository.getUserByEmail(email);
  },

  async removeMemberFromProject(projectId: string, userId: string) {
    const membership = await ProjectRepository.getMembership(projectId, userId);

    if (!membership) {
      throw new Error(`User with ID ${userId} is not a member of the project`);
    }

    return ProjectRepository.removeMember(projectId, userId);
  },

  async updateMemberRole(projectId: string, userId: string, role: ProjectRole) {
    const membership = await ProjectRepository.getMembership(projectId, userId);

    if (!membership) {
      throw new Error(`User with ID ${userId} is not a member of the project`);
    }

    return ProjectRepository.updateMemberRole(projectId, userId, role);
  },

}
