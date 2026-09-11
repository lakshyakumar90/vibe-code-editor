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
  /** Server-derived last-modified-by user id (human save or AI-apply initiator). */
  updatedByUserId?: string | null;
  /** Resolved display name (read-time join, never client-trusted). */
  updatedBy?: { userId: string; displayName: string } | null;
}