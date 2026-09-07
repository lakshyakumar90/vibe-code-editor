import { prisma, ProjectRole } from "@repo/db";
import { getManifest, getTemplateFiles } from "@repo/templates";
import type { TemplateManifest } from "@repo/templates";
import { createId } from "@paralleldrive/cuid2";
import { userAc } from "better-auth/plugins/admin/access";

function nameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function parentPathOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i === -1 ? null : path.slice(0, i);
}

function depthOf(path: string): number {
  return path.split("/").length;
}

export const ProjectRepository = {
  async createProject(data: {
    name: string;
    description?: string;
    template: TemplateManifest["id"];
    ownerId: string;
    memberIds?: string[];
  }) {
    let manifest;
    try {
      manifest = getManifest(data.template);
    } catch {
      throw new Error("TEMPLATE_NOT_FOUND");
    }

    const templateFiles = getTemplateFiles(data.template);
    if (templateFiles.length === 0) {
      throw new Error("TEMPLATE_EMPTY");
    }

    const memberCreates = [
      { userId: data.ownerId, role: ProjectRole.OWNER },
      ...(data.memberIds ?? [])
        .filter((id) => id !== data.ownerId)
        .map((userId) => ({ userId, role: ProjectRole.EDITOR })),
    ];

    // Folders before files, shallow before deep, so parentId always resolves.
    // Ids are pre-generated (cuid2, matching route/file validation) so the
    // whole seed fits in ONE array transaction — a single round trip that
    // works on pooled (PgBouncer) connections where interactive
    // transactions time out waiting for a dedicated connection.
    const folders = templateFiles
      .filter((f) => f.isFolder)
      .sort((a, b) => depthOf(a.path) - depthOf(b.path) || (a.path < b.path ? -1 : 1));
    const files = templateFiles
      .filter((f) => !f.isFolder)
      .sort((a, b) => depthOf(a.path) - depthOf(b.path) || (a.path < b.path ? -1 : 1));

    const projectId = createId();
    const pathToId = new Map<string, string>();

    const folderRows = folders.map((folder) => {
      const parentPath = parentPathOf(folder.path);
      const id = createId();
      const row = {
        id,
        name: nameOf(folder.path),
        path: folder.path,
        content: null,
        isFolder: true,
        projectId,
        parentId: parentPath ? (pathToId.get(parentPath) ?? null) : null,
      };
      pathToId.set(folder.path, id);
      return row;
    });

    const fileRows = files.map((file) => {
      const parentPath = parentPathOf(file.path);
      return {
        id: createId(),
        name: nameOf(file.path),
        path: file.path,
        content: file.content,
        isFolder: false,
        projectId,
        parentId: parentPath ? (pathToId.get(parentPath) ?? null) : null,
      };
    });

    await prisma.$transaction(
      [
        prisma.project.create({
          data: {
            id: projectId,
            name: data.name,
            description: data.description,
            template: data.template as any,
            templateVersion: manifest.version,
            ownerId: data.ownerId,
            members: {
              create: memberCreates,
            },
          },
        }),
        prisma.file.createMany({
          data: [...folderRows, ...fileRows],
        }),
      ],
      { maxWait: 15000, timeout: 30000 }
    );

    return prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        members: {
          select: {
            id: true,
            role: true,
            userId: true,
          },
        },
        _count: {
          select: { files: true },
        },
      },
    });
  },

  async getAllProjectsForUser(userId: string) {
    const projects = await prisma.project.findMany({
      where: {
        OR: [
          {
            ownerId: userId,
          },
          {
            members: {
              some: { userId },
            },
          },
        ],
      },
      orderBy: {
        updatedAt: "desc",
      },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        members: {
          select: {
            id: true,
            userId: true,
            role: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
        favorites: {
          where: { userId },
          select: { userId: true },
        },
      },
    });
    // Favorites first, then most recently updated.
    return projects
      .map(({ favorites, ...rest }) => ({
        ...rest,
        isFavorite: favorites.length > 0,
      }))
      .sort(
        (a, b) =>
          Number(b.isFavorite) - Number(a.isFavorite) ||
          b.updatedAt.getTime() - a.updatedAt.getTime(),
      );
  },

  async getProjectById(projectId: string, userId?: string) {
    const project = await prisma.project.findUnique({
      where: {
        id: projectId,
      },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        members: {
          select: {
            id: true,
            userId: true,
            role: true,
            createdAt: true,
          },
        },
        favorites: userId
          ? { where: { userId }, select: { userId: true } }
          : false,
      },
    });
    if (!project) return null;
    const { favorites, ...rest } = project as typeof project & {
      favorites?: Array<{ userId: string }>;
    };
    return { ...rest, isFavorite: (favorites?.length ?? 0) > 0 };
  },

  async updateProject(
    projectId: string,
    data: {
      name: string;
      description?: string | null;
    },
  ) {
    return prisma.project.update({
      where: {
        id: projectId,
      },
      data,
    });
  },

  async deleteProject(projectId: string) {
    return prisma.project.delete({
      where: {
        id: projectId,
      },
    });
  },

  /** Toggle the per-user star. Favorites cascade-delete with the project. */
  async toggleFavorite(projectId: string, userId: string) {
    const existing = await prisma.projectFavorite.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (existing) {
      await prisma.projectFavorite.delete({
        where: { projectId_userId: { projectId, userId } },
      });
      return { isFavorite: false };
    }
    await prisma.projectFavorite.create({
      data: { projectId, userId },
    });
    return { isFavorite: true };
  },

  async getMembership(projectId: string, userId: string) { 
    return prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId
        }
      }
    })
  },

  async getUserByEmail(email: string) {
    return prisma.user.findUnique({
      where: {
        email,
      }, 
      select: {
        id: true,
        email: true, 
        name: true,
      }
    })
  },

  async createMember(projectId: string, userId: string, role: ProjectRole) { 
    return prisma.projectMember.create({
      data: {
        projectId,
        userId,
        role
      }
    })
  },

  async updateMemberRole(projectId: string, userId: string, role: ProjectRole) {
    return prisma.projectMember.update({
      where: {
        projectId_userId: {
          projectId,
          userId
        }
      },
      data: {
        role
      }
    })
  },

  async removeMember(projectId: string, userId: string) {
    return prisma.projectMember.delete({
      where: {
        projectId_userId: {
          projectId,
          userId
        }
      }
    })
  }
};
