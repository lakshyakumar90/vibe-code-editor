import type { Request, Response } from "express";
import { prisma, ProjectRole } from "@repo/db";
import { planImport } from "./import.service";
import { importRepoSchema } from "./import.validation";

/**
 * Phase 3 — GitHub repository import endpoint.
 *
 * Same invariants as Phases 1–2: userId is session-derived, the GitHub
 * token is read server-side from Account and never serialized. The client
 * only selects owner/repo/root; template, sha, permissions and file
 * contents are all server-derived and re-verified. No Git execution.
 */
export const importController = {
  /**
   * POST /api/github/import — import a supported repository as a normal
   * IDE project with GitRepository metadata. Atomic: one transaction for
   * Project + File rows + GitRepository, only after the complete payload
   * was fetched and validated.
   */
  async importRepo(req: Request, res: Response) {
    const userId = req.user!.id as string;
    const parsed = importRepoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        code: "INVALID_BODY",
        message: "Request must include a valid owner, repo and optional root",
      });
    }
    const { owner, repo, root } = parsed.data;

    const account = await prisma.account.findFirst({
      where: { userId, providerId: "github" },
      select: { accessToken: true },
    });
    if (!account?.accessToken) {
      return res.status(409).json({
        success: false,
        code: "GITHUB_NOT_CONNECTED",
        message: "Connect GitHub to import repositories.",
      });
    }

    const plan = await planImport({
      userId,
      owner,
      repo,
      root,
      token: account.accessToken,
    });

    if (!plan.ok) {
      const body: Record<string, unknown> = {
        success: false,
        code: plan.code,
        message: plan.message,
      };
      if (plan.truncated !== undefined) body["truncated"] = plan.truncated;
      if (plan.reasons !== undefined) body["reasons"] = plan.reasons;
      return res.status(plan.status).json(body);
    }

    // ONE atomic transaction: Project + File rows + GitRepository.
    // Array form (single round trip), same PgBouncer-safe convention as
    // template project creation. Re-importing creates a separate project —
    // existing projects are never overwritten.
    const [project, , gitRepository] = await prisma.$transaction(
      [
        prisma.project.create({
          data: {
            id: plan.projectId,
            name: plan.project.name,
            description: plan.project.description,
            template: plan.project.template as never,
            templateVersion: plan.project.templateVersion,
            ownerId: plan.project.ownerId,
            members: {
              create: [{ userId: plan.project.ownerId, role: ProjectRole.OWNER }],
            },
          },
          include: { gitRepository: true },
        }),
        prisma.file.createMany({
          data: [...plan.folderRows, ...plan.fileRows],
        }),
        prisma.gitRepository.create({
          data: {
            projectId: plan.projectId,
            githubRepoId: plan.gitRepository.githubRepoId,
            owner: plan.gitRepository.owner,
            repo: plan.gitRepository.repo,
            fullName: plan.gitRepository.fullName,
            defaultBranch: plan.gitRepository.defaultBranch,
            currentBranch: plan.gitRepository.currentBranch,
            importedSha: plan.gitRepository.importedSha,
            private: plan.gitRepository.private,
            canRead: plan.gitRepository.canRead,
            canWrite: plan.gitRepository.canWrite,
            canAdmin: plan.gitRepository.canAdmin,
          },
        }),
      ],
      { maxWait: 15000, timeout: 60000 },
    );

    if (!project || !gitRepository) {
      throw new Error("IMPORT_TRANSACTION_FAILED");
    }

    return res.status(201).json({
      success: true,
      data: {
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          template: project.template,
          templateVersion: project.templateVersion,
          ownerId: project.ownerId,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
        gitRepository: {
          id: gitRepository.id,
          projectId: gitRepository.projectId,
          githubRepoId: gitRepository.githubRepoId,
          owner: gitRepository.owner,
          repo: gitRepository.repo,
          fullName: gitRepository.fullName,
          defaultBranch: gitRepository.defaultBranch,
          currentBranch: gitRepository.currentBranch,
          importedSha: gitRepository.importedSha,
          private: gitRepository.private,
          canRead: gitRepository.canRead,
          canWrite: gitRepository.canWrite,
          canAdmin: gitRepository.canAdmin,
          createdAt: gitRepository.createdAt,
          updatedAt: gitRepository.updatedAt,
        },
        stats: plan.stats,
      },
    });
  },
};
