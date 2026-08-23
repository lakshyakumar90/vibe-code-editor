export interface UpsertFileInput {
  name: string;
  content?: string;
  parentId?: string | null;
  isFolder: boolean;
}

export interface UpdateFileInput {
  name?: string;
  content?: string;
  parentId?: string | null;
  isFolder?: boolean;
}

export interface MoveFileInput {
  parentId: string | null;
}
