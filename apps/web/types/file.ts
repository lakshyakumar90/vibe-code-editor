export interface ProjectFile {
  id: string;
  name: string;
  path: string;
  content: string | null;
  projectId: string;
  parentId: string | null;
  isFolder: boolean;
  createdAt: string;
  updatedAt: string;
}