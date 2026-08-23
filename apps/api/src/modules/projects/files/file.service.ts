import { fileRepository } from "./file.repository";
import { buildFilePath } from "./file.utils";

export const fileService = {
  async listAllFiles(projectId: string) {
    return fileRepository.getAllFiles(projectId);
  },

  async getFileByPath(projectId: string, path: string) {
    return fileRepository.getFileByPath(projectId, path);
  },

  async getFileById(fileId: string, projectId: string) {
    return fileRepository.getFileById(fileId, projectId);
  },

  async createFile(
    projectId: string,
    input: {
      name: string;
      content?: string | undefined;
      parentId?: string | null | undefined;
      isFolder: boolean;
    },
  ) {
    const parentId = input.parentId ?? null;

    let parentPath: string | null = null;

    if (parentId) {
      const parent = await fileRepository.getParent(projectId, parentId);
      if (!parent) {
        throw new Error("Parent folder not found");
      }
      if (!parent.isFolder) {
        throw new Error("Parent is not a folder");
      }
      parentPath = parent.path;
    }

    const path = buildFilePath(input.name, parentPath);

    return fileRepository.createFile({
      projectId,
      name: input.name,
      content: input.content,
      parentId,
      isFolder: input.isFolder,
      path,
    });
  },

  async updateFile(
    fileId: string,
    projectId: string,
    input: {
      name?: string | null;
      content?: string | null | undefined;
      parentId?: string | null | undefined;
      isFolder?: boolean;
    },
  ) {
    const file = await fileRepository.getFileById(fileId, projectId);
    if (!file) {
      throw new Error("File not found");
    }

    let parentPath: string | null = null;

    if (input.parentId) {
      const parent = await fileRepository.getParent(projectId, input.parentId);
      if (!parent) {
        throw new Error("Parent folder not found");
      }
      if (!parent.isFolder) {
        throw new Error("Parent is not a folder");
      }
      parentPath = parent.path;
    }

    const path = buildFilePath(input.name ?? file.name, parentPath);

    return fileRepository.updateFile(fileId, projectId, {
      name: input.name ?? file.name,
      content: input.content ?? file.content,
      parentId: input.parentId ?? file.parentId,
      isFolder: input.isFolder ?? file.isFolder,
      path,
    });
  },

  async deleteFile(fileId: string, projectId: string) {
    return fileRepository.deleteFile(fileId, projectId);
  },

  async moveFile(
    projectId: string,
    fileId: string,
    newParentId: string | null,
    newName: string,
  ) {
    return fileRepository.moveFile(projectId, fileId, newParentId, newName);
  },
};
