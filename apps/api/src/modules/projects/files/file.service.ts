import { prisma } from "@repo/db";
import { fileRepository } from "./file.repository";
import { buildFilePath } from "./file.utils";

/**
 * Resolve Better Auth display names for "last modified by" tracking.
 * Read-time join over the stored server-derived user id — the client is
 * never trusted for identity. Best-effort: unknown users become null.
 */
async function withUpdatedBy<T extends { updatedByUserId?: string | null }>(
  files: T[],
): Promise<Array<T & { updatedBy: { userId: string; displayName: string } | null }>> {
  const ids = [...new Set(files.map((f) => f.updatedByUserId).filter((u): u is string => !!u))];
  if (ids.length === 0) {
    return files.map((f) => ({ ...f, updatedBy: null }));
  }
  const users = await prisma.user
    .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    .catch(() => []);
  const byId = new Map(users.map((u) => [u.id, u]));
  return files.map((f) => {
    if (!f.updatedByUserId) return { ...f, updatedBy: null };
    const u = byId.get(f.updatedByUserId);
    return {
      ...f,
      updatedBy: {
        userId: f.updatedByUserId,
        displayName: u?.name?.trim() || "Unknown user",
      },
    };
  });
}

export const fileService = {
  async listAllFiles(projectId: string) {
    const files = await fileRepository.getAllFiles(projectId);
    return withUpdatedBy(files);
  },

  async getFileByPath(projectId: string, path: string) {
    const file = await fileRepository.getFileByPath(projectId, path);
    if (!file) return file;
    const [enriched] = await withUpdatedBy([file]);
    return enriched;
  },

  async getFileById(fileId: string, projectId: string) {
    const file = await fileRepository.getFileById(fileId, projectId);
    if (!file) return file;
    const [enriched] = await withUpdatedBy([file]);
    return enriched;
  },

  async createFile(
    projectId: string,
    input: {
      name: string;
      content?: string | null | undefined;
      parentId?: string | null | undefined;
      isFolder: boolean;
      updatedByUserId?: string | null;
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

    const created = await fileRepository.createFile({
      projectId,
      name: input.name,
      content: input.content,
      parentId,
      isFolder: input.isFolder,
      path,
      ...(input.updatedByUserId ? { updatedByUserId: input.updatedByUserId } : {}),
    });
    // Return the row with resolved attribution so the saver's UI can show
    // "Last modified by me" immediately instead of waiting for a refresh.
    const [enriched] = await withUpdatedBy([created]);
    return enriched;
  },

  async updateFile(
    fileId: string,
    projectId: string,
    input: {
      name?: string | null;
      content?: string | null | undefined;
      parentId?: string | null | undefined;
      isFolder?: boolean;
      updatedByUserId?: string | null;
    },
  ) {
    const file = await fileRepository.getFileById(fileId, projectId);
    if (!file) {
      throw new Error("File not found");
    }

    const effectiveParentId =
      input.parentId !== undefined ? input.parentId : file.parentId;

    let parentPath: string | null = null;

    if (effectiveParentId) {
      const parent = await fileRepository.getParent(
        projectId,
        effectiveParentId,
      );
      if (!parent) {
        throw new Error("Parent folder not found");
      }
      if (!parent.isFolder) {
        throw new Error("Parent is not a folder");
      }
      parentPath = parent.path;
    }

    const effectiveName = input.name ?? file.name;
    const path = buildFilePath(effectiveName, parentPath);

    const saved = await fileRepository.updateFile(fileId, projectId, {
      name: effectiveName,
      content: input.content ?? file.content,
      parentId: effectiveParentId,
      isFolder: input.isFolder ?? file.isFolder,
      path,
      ...(input.updatedByUserId ? { updatedByUserId: input.updatedByUserId } : {}),
    });
    // Same as create: resolve attribution in the save response itself.
    const [enriched] = await withUpdatedBy([saved]);
    return enriched;
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
