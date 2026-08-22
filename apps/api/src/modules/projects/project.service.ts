import { ProjectRole } from "@repo/db";
import type { CreateProjectInput, UpdateProjectInput } from "./project.types";
import { ProjectRepository } from "./project.repository";

export const projectService = {
  async createProject(
    userId: string,
    input: CreateProjectInput
  ) {
    const project = await ProjectRepository.createProject({
      name: input.name,
      description: input.description,
      ownerId: userId,
    });

    return project;
  },

  async getAllProjectsForUser(userId: string) {
    return ProjectRepository.getAllProjectsForUser(userId);
  },

  async getProjectById(projectId: string) {
    return ProjectRepository.getProjectById(projectId);
  },

  async updateProject(projectId: string, input: UpdateProjectInput) {
    return ProjectRepository.updateProject(projectId, input);
  },

  async deleteProject(projectId: string) {
    return ProjectRepository.deleteProject(projectId);
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
