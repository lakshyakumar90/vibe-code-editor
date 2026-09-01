import { ProjectRole } from "@repo/db";

export interface CreateProjectInput {
  name: string;
  description?: string;
  template: string;
  memberIds?: string[];
};

export interface UpdateProjectInput {
  name: string;
  description?: string | null | undefined;
};

export interface ProjectAccess {
  projectId: string;
  role: ProjectRole;
  userId: string;
}