import { prisma } from "@repo/db";
import { updateFileSchema } from "./file.validation";
import { buildFilePath } from "./file.utils";

export const fileRepository = {
  async getAllFiles(projectId: string) {
    return prisma.file.findMany({
      where: { projectId },
      orderBy: [{ path: "asc" }],
      select: {
        id: true,
        name: true,
        content: true,
        parentId: true,
        isFolder: true,
        path: true,
        projectId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  },

  async getFileByPath(projectId: string, path: string) {
    return prisma.file.findUnique({
      where: { projectId_path: { projectId, path } },
      select: {
        id: true,
        name: true,
        content: true,
        parentId: true,
        isFolder: true,
        path: true,
        projectId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  },

  async getFileById(fileId: string, projectId: string) {
    return prisma.file.findUnique({
      where: { id: fileId, projectId },
      select: {
        id: true,
        name: true,
        content: true,
        parentId: true,
        isFolder: true,
        path: true,
        projectId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  },

  async getParent(projectId: string, parentId: string | null) {
    if (!parentId) return null;
    return prisma.file.findFirst({
      where: { id: parentId, projectId },
    });
  },

  async createFile(data: {
    name: string;
    content?: string;
    parentId?: string | null;
    isFolder: boolean;
    path: string;
    projectId: string;
  }) {
    return prisma.file.create({
      data,
    });
  },

  async updateFile(
    fileId: string,
    projectId: string,
    data: Partial<{
      name?: string;
      content?: string | null;
      parentId?: string | null;
      isFolder?: boolean;
      path?: string;
    }>,
  ) {
    return prisma.file.updateMany({
      where: { id: fileId, projectId },
      data,
    });
  },

  async updateFileByPath(
    projectId: string,
    path: string,
    data: Partial<{
      name?: string;
      content?: string;
      parentId?: string | null;
      isFolder?: boolean;
      path?: string;
    }>,
  ) {
    return prisma.file.update({
      where: { projectId_path: { projectId, path } },
      data,
    });
  },

  async deleteFile(fileId: string, projectId: string) {
    return prisma.file.deleteMany({
      where: { id: fileId, projectId },
    });
  },

  async moveFile(
    projectId: string,
    fileId: string,
    newParentId: string | null,
    newName: string,
  ) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.file.findFirst({
        where: { id: fileId, projectId },
      });

      if (!item) {
        throw new Error("FILE_NOT_FOUND");
      }

      let newParentPath: string | null = null;
      if (newParentId !== null && newParentId !== undefined) {
        if (newParentId === fileId) {
          throw new Error("CANNOT_MOVE_ITEM_INTO_ITSELF");
        }

        const parent = await tx.file.findFirst({
          where: { id: newParentId, projectId },
        });

        if (!parent) {
          throw new Error("PARENT_NOT_FOUND");
        }
        if (!parent.isFolder) {
          throw new Error("PARENT_NOT_FOLDER");
        }
        if (item.isFolder && parent.path.startsWith(item.path + "/")) {
          throw new Error("CANNOT_MOVE_FOLDER_INTO_ITS_OWN_DESCENDANT");
        }

        newParentPath = parent.path;
      }

      const newPath = buildFilePath(newName, newParentPath);

      if (newPath === item.path) {
        return item;
      }

      const conflictingFile = await tx.file.findUnique({
        where: {
          projectId_path: {
            projectId,
            path: newPath,
          },
        },
      });

      if (conflictingFile) {
        throw new Error("PATH_ALREADY_EXISTS");
      }

      const oldPath = item.path;

      //update item itself with new name, parentId and path
      const updatedItem = await tx.file.update({
        where: { id: item.id },
        data: {
          name: newName,
          parentId: newParentId ?? null,
          path: newPath,
        },
      });

      //if its folder, update every descendant path
      if (item.isFolder) {
        const descendants = await tx.file.findMany({
          where: {
            projectId,
            path: {
              startsWith: oldPath + "/",
            },
          },
          select: { id: true, path: true },
        });

        for (const descendant of descendants) {
          const relativePath = descendant.path.substring(oldPath.length);

          await tx.file.update({
            where: { id: descendant.id },
            data: { path: newPath + relativePath },
          });
        }
      }

      return updatedItem;
    });
  },
};
