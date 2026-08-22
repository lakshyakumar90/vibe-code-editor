import { Request, Response } from "express";
import { createProjectSchema, updateProjectSchema } from "./project.validation";
import { projectService } from "./project.service";
import { ProjectRole } from "@repo/db";

export const projectController = {
  async createProject(req: Request, res: Response) {
    const input = createProjectSchema.parse(req.body);
    const project = await projectService.createProject(req.user!.id, input);
    return res.status(201).json({
      success: true,
      data: project,
    });
  },
  
  async getAllProjects(req: Request, res: Response) { 
    const projects = await projectService.getAllProjectsForUser(req.user!.id);
    return res.status(200).json({
      success: true,
      data: projects,
    });
  },

  async getProjectById(req: Request, res: Response) {
    const { projectId } = req.params;

    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_PROJECT",
        message: "Project ID must be a valid single string",
      });
    }
    
    const project = await projectService.getProjectById(projectId);

    if (!project) {
      return res.status(404).json({
        success: false,
        code: "PROJECT_NOT_FOUND",
        message: "Project not found",
      });
    }
    
    return res.status(200).json({
      success: true,
      data: project,
    });
  },

  async updateProject(req: Request, res: Response) {
    const { projectId } = req.params;
    const input = updateProjectSchema.parse(req.body);

    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_PROJECT",
        message: "Project ID must be a valid single string",
      });
    }

    const updatedProject = await projectService.updateProject(projectId, input);

    if (!updatedProject) {
      return res.status(404).json({
        success: false,
        code: "PROJECT_NOT_FOUND",
        message: "Project not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: updatedProject,
    });
  },

  async deleteProject(req: Request, res: Response) {
    const { projectId } = req.params;

    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_PROJECT",
        message: "Project ID must be a valid single string",
      });
    }

    const deletedProject = await projectService.deleteProject(projectId);

    if (!deletedProject) {
      return res.status(404).json({
        success: false,
        code: "PROJECT_NOT_FOUND",
        message: "Project not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: deletedProject,
    });
  },

  async addMemberToProject(req: Request, res: Response) {
    const { projectId } = req.params;
    const { email, role } = req.body;

    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_PROJECT",
        message: "Project ID must be a valid single string",
      });
    }

    try {
      const member = await projectService.addMemberToProject(projectId, email, role);
      return res.status(201).json({
        success: true,
        data: member,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        code: "ADD_MEMBER_FAILED",
        message: error instanceof Error ? error.message : "Failed to add member",
      });
    }
  },

  async removeMemberFromProject(req: Request, res: Response) {
    const { projectId } = req.params;
    const { userId } = req.body;

    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_PROJECT",
        message: "Project ID must be a valid single string",
      });
    }

    try {
      const member = await projectService.removeMemberFromProject(projectId, userId);
      return res.status(200).json({
        success: true,
        data: member,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        code: "REMOVE_MEMBER_FAILED",
        message: error instanceof Error ? error.message : "Failed to remove member",
      });
    }
  },

  async getMembership(req: Request, res: Response) {
    const { projectId } = req.params;
    const userId = req.user?.id;

    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_PROJECT",
        message: "Project ID must be a valid single string",
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        code: "INVALID_USER",
        message: "User not authenticated",
      });
    }
    
    const membership = await projectService.getMembership(projectId, userId);

    if (!membership) {
      return res.status(404).json({
        success: false,
        code: "MEMBERSHIP_NOT_FOUND",
        message: "Membership not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: membership,
    });
  },

  async getUserByEmail(req: Request, res: Response) {
    const { email } = req.query;

    if (!email || typeof email !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_EMAIL",
        message: "Email must be a valid string",
      });
    }

    const user = await projectService.getUserByEmail(email);

    if (!user) {
      return res.status(404).json({
        success: false,
        code: "USER_NOT_FOUND",
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: user,
    });
  },

  async updateMemberRole(req: Request, res: Response) {
    const { projectId } = req.params;
    const { userId, role } = req.body;

    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_PROJECT",
        message: "Project ID must be a valid single string",
      });
    }

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_USER",
        message: "User ID must be a valid single string",
      });
    }

    if (!role || !Object.values(ProjectRole).includes(role as ProjectRole)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_ROLE",
        message: `Role must be one of: ${Object.values(ProjectRole).join(", ")}`,
      });
    }

    try {
      const member = await projectService.updateMemberRole(projectId, userId, role);
      return res.status(200).json({
        success: true,
        data: member,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        code: "UPDATE_MEMBER_ROLE_FAILED",
        message: error instanceof Error ? error.message : "Failed to update member role",
      });
    }
  },
};
