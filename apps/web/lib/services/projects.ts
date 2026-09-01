import { api } from "@/lib/api";

export interface ProjectMember {
  id: string;
  userId: string;
  role: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  template: string;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  owner: {
    id: string;
    name: string;
    email: string;
  };
  members: ProjectMember[];
}

export interface CreateProjectData {
  name: string;
  description?: string;
  template: string;
  memberIds?: string[];
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export const projectService = {
  async getAllProjects(): Promise<Project[]> {
    const response = await api.get<ApiResponse<Project[]>>("/api/projects");
    return response.data;
  },

  async getProjectById(id: string): Promise<Project> {
    const response = await api.get<ApiResponse<Project>>(`/api/projects/${id}`);
    return response.data;
  },

  async createProject(data: CreateProjectData): Promise<Project> {
    const response = await api.post<ApiResponse<Project>>("/api/projects/create", data);
    return response.data;
  },

  async updateProject(id: string, data: Partial<CreateProjectData>): Promise<Project> {
    const response = await api.put<ApiResponse<Project>>(`/api/projects/${id}`, data);
    return response.data;
  },

  async deleteProject(id: string): Promise<void> {
    await api.delete<ApiResponse<void>>(`/api/projects/${id}`);
  },
};
