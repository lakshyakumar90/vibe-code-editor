import { ProjectRole } from "@repo/db";
import type { TemplateManifest } from "@repo/templates";

export type ProjectTemplate = TemplateManifest["id"];

export interface CreateProjectInput {
  name: string;
  description?: string;
  template: ProjectTemplate;
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