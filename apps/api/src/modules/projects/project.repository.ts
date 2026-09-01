import { prisma, ProjectRole } from "@repo/db";
import { userAc } from "better-auth/plugins/admin/access";

export const ProjectRepository = {
  async createProject(data: {
    name: string;
    description?: string;
    template: string;
    ownerId: string;
    memberIds?: string[];
  }) {
    const memberCreates = [
      { userId: data.ownerId, role: ProjectRole.OWNER },
      ...(data.memberIds ?? [])
        .filter((id) => id !== data.ownerId)
        .map((userId) => ({ userId, role: ProjectRole.EDITOR })),
    ];

    return prisma.project.create({
      data: {
        name: data.name,
        description: data.description,
        template: data.template as any,
        ownerId: data.ownerId,
        members: {
          create: memberCreates,
        },
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
            role: true,
            userId: true,
          },
        },
      },
    });
  },

  async getAllProjectsForUser(userId: string) {
    return prisma.project.findMany({
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
      },
    });
  },

  async getProjectById(projectId: string) {
    return prisma.project.findUnique({
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
      },
    });
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
