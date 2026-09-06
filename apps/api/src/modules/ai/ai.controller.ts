import type { Request, Response } from "express";
import { prisma, ProjectRole } from "@repo/db";
import {
  AIOrchestrator,
  computeDiffs,
  createProvider,
  makeEvent,
  serializeSSE,
  SUPPORTED_PROVIDERS,
  validateChangeSet,
  type AiProviderId,
  type ChangeSetInput,
  type GenerateInput,
  type RunStore,
  type WorkspaceReader,
} from "@repo/ai";
import {
  aiCompleteSchema,
  aiGenerateSchema,
  inlineCompletionResultSchema,
} from "@repo/validation";
import { fileRepository } from "../projects/files/file.repository";

/**
 * Phase 3: real orchestrator wiring. Mode routes, SSE generate,
 * conversations, and the changeset review gate. Inline completion
 * endpoint included (UI deferred — ghost text stays out of scope).
 */

const MODE_MIN_ROLE: Record<string, ProjectRole> = {
  ask: ProjectRole.VIEWER,
  plan: ProjectRole.VIEWER,
  agent: ProjectRole.EDITOR,
};

const ROLE_LEVEL: Record<ProjectRole, number> = {
  [ProjectRole.VIEWER]: 1,
  [ProjectRole.EDITOR]: 2,
  [ProjectRole.OWNER]: 3,
};

const orchestrator = new AIOrchestrator();

function validationError(res: Response, message: string, errors: Array<{ path: string; message: string }>) {
  return res.status(400).json({ success: false, code: "VALIDATION_ERROR", message, errors });
}

/** Express 5 query/params values can be string|string[] — narrow to string. */
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

async function checkUserProjectAccess(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const project = await prisma.project
    .findUnique({ where: { id: projectId }, select: { ownerId: true } })
    .catch(() => null);
  if (!project) return false;
  if (project.ownerId === userId) return true;
  const membership = await prisma.projectMember
    .findUnique({ where: { projectId_userId: { projectId, userId } } })
    .catch(() => null);
  return !!membership;
}

async function resolveRole(projectId: string, userId: string): Promise<ProjectRole> {
  const project = await prisma.project
    .findUnique({ where: { id: projectId }, select: { ownerId: true } })
    .catch(() => null);
  if (project?.ownerId === userId) return ProjectRole.OWNER;
  const membership = await prisma.projectMember
    .findUnique({ where: { projectId_userId: { projectId, userId } } })
    .catch(() => null);
  return membership?.role ?? ProjectRole.VIEWER;
}

const workspaceFiles: WorkspaceReader = {
  async listFiles(projectId: string) {
    const files = await fileRepository.getAllFiles(projectId);
    return files.map((f) => ({ path: f.path, isFolder: f.isFolder }));
  },
  async readFile(projectId: string, path: string) {
    const file = await fileRepository.getFileByPath(projectId, path).catch(() => null);
    if (!file || file.isFolder) return null;
    return file.content;
  },
};

export const aiController = {
  async getStatus(_req: Request, res: Response) {
    const provider = createProvider();
    return res.json({
      success: true,
      data: {
        provider: provider.id,
        name: provider.name,
        configured: provider.isConfigured(),
        defaultModel: process.env["AI_DEFAULT_MODEL"] || provider.defaultModel(),
      },
    });
  },

  async listProviders(_req: Request, res: Response) {
    const def = (process.env["AI_PROVIDER"] ?? "openai").toLowerCase();
    const providers = (
      Object.keys(SUPPORTED_PROVIDERS) as Array<keyof typeof SUPPORTED_PROVIDERS>
    ).map((id) => {
      const meta = SUPPORTED_PROVIDERS[id];
      let configured = false;
      try {
        configured = createProvider(id).isConfigured();
      } catch {
        configured = false;
      }
      return { ...meta, configured, isDefault: def === id };
    });
    return res.json({ success: true, data: providers });
  },

  async listConversations(req: Request, res: Response) {
    const projectId =
      str(req.query["projectId"]);
    if (!projectId) {
      return res.status(400).json({ success: false, code: "INVALID_PROJECT", message: "projectId required" });
    }
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, code: "INVALID_USER", message: "Not authenticated" });
    }
    try {
      const convs = await prisma.aIConversation.findMany({
        where: { projectId, userId: user.id },
        orderBy: { updatedAt: "desc" },
        take: 20,
        include: { _count: { select: { messages: true } } },
      });
      return res.json({ success: true, data: convs });
    } catch (e) {
      return res.status(500).json({
        success: false,
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  },

  async getConversation(req: Request, res: Response) {
    const id = str(req.params["id"]);
    if (!id) {
      return res.status(400).json({ success: false, code: "INVALID_ID", message: "id required" });
    }
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, code: "INVALID_USER", message: "Not authenticated" });
    }
    try {
      const conv = await prisma.aIConversation.findUnique({
        where: { id },
        include: {
          messages: { orderBy: { createdAt: "asc" }, take: 50 },
          plans: { orderBy: { createdAt: "desc" }, take: 5 },
          runs: { orderBy: { createdAt: "desc" }, take: 5 },
        },
      });
      if (!conv || conv.userId !== user.id) {
        return res.status(404).json({ success: false, code: "NOT_FOUND", message: "Conversation not found" });
      }
      return res.json({ success: true, data: conv });
    } catch (e) {
      return res.status(500).json({
        success: false,
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  },

  async getMessages(req: Request, res: Response) {
    const id = str(req.params["id"]);
    const limit = Math.min(parseInt(str(req.query["limit"]) ?? "50") || 50, 100);
    const offset = parseInt(str(req.query["offset"]) ?? "0") || 0;
    if (!id) {
      return res.status(400).json({ success: false, code: "INVALID_ID", message: "id required" });
    }
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, code: "INVALID_USER", message: "Not authenticated" });
    }
    try {
      const conv = await prisma.aIConversation.findUnique({ where: { id } });
      if (!conv || conv.userId !== user.id) {
        return res.status(404).json({ success: false, code: "NOT_FOUND", message: "Conversation not found" });
      }
      const messages = await prisma.aIMessage.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "asc" },
        take: limit,
        skip: offset,
      });
      const total = await prisma.aIMessage
        .count({ where: { conversationId: id } })
        .catch(() => messages.length);
      return res.json({
        success: true,
        data: { messages, total, hasMore: offset + messages.length < total },
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  },

  async complete(req: Request, res: Response) {
    const parsed = aiCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(
        res,
        "Invalid complete request",
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    const input = parsed.data;
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, code: "INVALID_USER", message: "User not authenticated" });
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 15000);
    const onClose = () => {
      abortController.abort();
      clearTimeout(timeout);
    };
    req.on("close", onClose);
    try {
      const completion = await orchestrator.completeInline({
        prefix: input.prefix,
        suffix: input.suffix ?? "",
        language: input.language,
        filePath: input.filePath,
        provider: input.provider,
        model: input.model,
        temperature: input.temperature ?? 0.2,
        signal: abortController.signal,
      });
      const validated = inlineCompletionResultSchema.safeParse({ completion });
      clearTimeout(timeout);
      if (!validated.success) {
        return res.status(500).json({ success: false, code: "INVALID_COMPLETION", message: "Completion failed validation" });
      }
      return res.json({ success: true, data: validated.data });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && (err.name === "AbortError" || abortController.signal.aborted)) {
        return res.status(499).json({ success: false, code: "ABORTED", message: "Request aborted" });
      }
      return res.status(500).json({
        success: false,
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      req.off?.("close", onClose);
    }
  },

  async generate(req: Request, res: Response) {
    // Validate BEFORE SSE headers so failures stay JSON 400/403.
    const parsed = aiGenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(
        res,
        "Invalid request data",
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    const input = parsed.data;
    const requiredRole = MODE_MIN_ROLE[input.mode] ?? ProjectRole.VIEWER;
    const actualRole =
      (res.locals.projectAccess as { role?: ProjectRole } | undefined)?.role ??
      ProjectRole.VIEWER;
    if (ROLE_LEVEL[actualRole] < ROLE_LEVEL[requiredRole]) {
      return res.status(403).json({
        success: false,
        code: "INSUFFICIENT_PERMISSIONS",
        message: `Mode "${input.mode}" requires ${requiredRole} role`,
      });
    }
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, code: "INVALID_USER", message: "Not authenticated" });
    }

    // Conversation ownership (project match) verified before streaming.
    if (input.conversationId) {
      const conv = await prisma.aIConversation
        .findUnique({ where: { id: input.conversationId } })
        .catch(() => null);
      if (!conv || conv.userId !== user.id || conv.projectId !== input.projectId) {
        return res.status(404).json({
          success: false,
          code: "NOT_FOUND",
          message: "Conversation not found",
        });
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const keepAlive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        // client gone — close handler cleans up
      }
    }, 15000);
    const abortController = new AbortController();
    let aborted = false;
    const onClose = () => {
      aborted = true;
      abortController.abort();
      clearInterval(keepAlive);
    };
    req.on("close", onClose);

    const store: RunStore = {
      async saveMessages(conversationId: string, userId: string, messages: Array<{ role: string; content: string }>) {
        await prisma.aIMessage.createMany({
          data: messages.map((m) => ({ conversationId, role: m.role, content: m.content })),
        });
        await prisma.aIConversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });
      },
      async savePlan(p: { conversationId: string; projectId: string; userId: string; tasks: Array<{ title: string; status: string }> }) {
        const plan = await prisma.aIPlan.create({
          data: {
            conversationId: p.conversationId,
            projectId: p.projectId,
            userId: p.userId,
            status: "ready",
            steps: p.tasks,
          },
        });
        return { id: plan.id };
      },
      async saveRun(r: { conversationId?: string; projectId: string; userId: string; mode: string }) {
        const run = await prisma.aIRun.create({
          data: {
            conversationId: r.conversationId,
            projectId: r.projectId,
            userId: r.userId,
            mode: r.mode,
            status: "running",
          },
        });
        return { id: run.id };
      },
      async updateRun(id: string, status: string) {
        await prisma.aIRun.update({ where: { id }, data: { status } }).catch(() => null);
      },
      async saveChangeSet(s: { projectId: string; runId?: string; userId: string; changes: ChangeSetInput }) {
        const cs = await prisma.changeSet.create({
          data: {
            projectId: s.projectId,
            runId: s.runId,
            userId: s.userId,
            status: "pending",
            changes: s.changes as object,
          },
        });
        return { id: cs.id };
      },
    };

    try {
      const genInput: GenerateInput = {
        mode: input.mode,
        projectId: input.projectId,
        prompt: input.prompt,
        attachments: input.attachments,
        selection: input.selection,
        contextPaths: input.contextPaths,
        provider: input.provider,
        model: input.model,
        temperature: input.temperature,
        conversationId: input.conversationId,
        planId: input.planId,
        history: input.history,
        signal: abortController.signal,
      };
      const stream = orchestrator.generate(
        genInput,
        { userId: user.id, projectRole: actualRole },
        { files: workspaceFiles, store },
      );
      for await (const event of stream) {
        if (aborted || res.writableEnded) break;
        try {
          res.write(serializeSSE(event));
        } catch {
          break;
        }
      }
    } catch (err) {
      if (!res.writableEnded) {
        try {
          res.write(
            serializeSSE(
              makeEvent("error", {
                code: "INTERNAL_ERROR",
                message: err instanceof Error ? err.message : "Unknown error",
              }),
            ),
          );
          res.write(serializeSSE(makeEvent("done", { status: "failed" })));
        } catch {
          // response already dead
        }
      }
    } finally {
      clearInterval(keepAlive);
      req.off?.("close", onClose);
      try {
        res.end();
      } catch {
        // already ended
      }
    }
  },

  async getChangeSet(req: Request, res: Response) {
    const id = str(req.params["id"]);
    if (!id) {
      return res.status(400).json({ success: false, code: "INVALID_ID", message: "id required" });
    }
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, code: "INVALID_USER", message: "Not authenticated" });
    }
    try {
      const cs = await prisma.changeSet.findUnique({ where: { id } });
      if (!cs) {
        return res.status(404).json({ success: false, code: "NOT_FOUND", message: "ChangeSet not found" });
      }
      if (!(await checkUserProjectAccess(cs.projectId, user.id))) {
        return res.status(403).json({ success: false, code: "FORBIDDEN", message: "No access to this project" });
      }
      const raw = cs.changes as { changes?: unknown } | unknown[];
      const changes = Array.isArray((raw as { changes?: unknown })?.changes)
        ? ((raw as { changes: Array<{ path: string; content: string | null; delete?: boolean }> }).changes)
        : [];
      const diffs = await computeDiffs(changes, async (path) => {
        const file = await fileRepository.getFileByPath(cs.projectId, path).catch(() => null);
        return file && !file.isFolder ? file.content : null;
      });
      return res.json({ success: true, data: { changeSet: cs, diffs } });
    } catch (e) {
      return res.status(500).json({
        success: false,
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  },

  async applyChangeSet(req: Request, res: Response) {
    const id = str(req.params["id"]);
    if (!id) {
      return res.status(400).json({ success: false, code: "INVALID_ID", message: "id required" });
    }
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, code: "INVALID_USER", message: "Not authenticated" });
    }
    try {
      const cs = await prisma.changeSet.findUnique({ where: { id } });
      if (!cs) {
        return res.status(404).json({ success: false, code: "NOT_FOUND", message: "ChangeSet not found" });
      }
      if (cs.status !== "pending") {
        return res.status(400).json({
          success: false,
          code: "INVALID_STATUS",
          message: `ChangeSet is ${cs.status}, not pending`,
        });
      }
      if (!(await checkUserProjectAccess(cs.projectId, user.id))) {
        return res.status(403).json({ success: false, code: "FORBIDDEN", message: "No access" });
      }
      const role = await resolveRole(cs.projectId, user.id);
      if (role === ProjectRole.VIEWER) {
        return res.status(403).json({
          success: false,
          code: "INSUFFICIENT_PERMISSIONS",
          message: "EDITOR role required to apply",
        });
      }
      const raw = cs.changes as { changes?: unknown };
      const existing = await fileRepository.getAllFiles(cs.projectId);
      const existingPaths = new Set(existing.filter((f) => !f.isFolder).map((f) => f.path));
      const existingFolders = new Set(existing.filter((f) => f.isFolder).map((f) => f.path));
      const vRes = validateChangeSet(raw, { existingPaths, existingFolders });
      if (!vRes.valid || !vRes.normalized) {
        return res.status(400).json({
          success: false,
          code: "VALIDATION_FAILED",
          message: vRes.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
        });
      }
      const applied: string[] = [];
      for (const change of vRes.normalized.changes) {
        if (change.delete === true) {
          const target = await fileRepository.getFileByPath(cs.projectId, change.path);
          if (target) {
            await fileRepository.deleteFile(target.id, cs.projectId);
            applied.push(change.path);
          }
          continue;
        }
        const target = await fileRepository.getFileByPath(cs.projectId, change.path);
        if (target) {
          await fileRepository.updateFileByPath(cs.projectId, change.path, {
            content: change.content ?? "",
          });
          applied.push(change.path);
          continue;
        }
        const slash = change.path.lastIndexOf("/");
        const dir = slash === -1 ? "" : change.path.slice(0, slash);
        const name = slash === -1 ? change.path : change.path.slice(slash + 1);
        let parentId: string | null = null;
        if (dir !== "") {
          const folder = await fileRepository.getFileByPath(cs.projectId, dir);
          if (!folder || !folder.isFolder) {
            return res.status(400).json({
              success: false,
              code: "VALIDATION_FAILED",
              message: `Parent folder "${dir}" no longer exists`,
            });
          }
          parentId = folder.id;
        }
        await fileRepository.createFile({
          projectId: cs.projectId,
          name,
          content: change.content ?? "",
          parentId,
          isFolder: false,
          path: change.path,
        });
        applied.push(change.path);
      }
      await prisma.changeSet.update({
        where: { id },
        data: { status: "applied", resolvedAt: new Date(), resolvedBy: user.id },
      });
      return res.json({ success: true, data: { changeSetId: id, status: "applied", files: applied } });
    } catch (e) {
      return res.status(500).json({
        success: false,
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  },

  async rejectChangeSet(req: Request, res: Response) {
    const id = str(req.params["id"]);
    if (!id) {
      return res.status(400).json({ success: false, code: "INVALID_ID", message: "id required" });
    }
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ success: false, code: "INVALID_USER", message: "Not authenticated" });
    }
    try {
      const cs = await prisma.changeSet.findUnique({ where: { id } });
      if (!cs) {
        return res.status(404).json({ success: false, code: "NOT_FOUND", message: "ChangeSet not found" });
      }
      if (cs.status !== "pending") {
        return res.status(400).json({
          success: false,
          code: "INVALID_STATUS",
          message: `ChangeSet is ${cs.status}, not pending`,
        });
      }
      if (!(await checkUserProjectAccess(cs.projectId, user.id))) {
        return res.status(403).json({ success: false, code: "FORBIDDEN", message: "No access" });
      }
      await prisma.changeSet.update({
        where: { id },
        data: { status: "rejected", resolvedAt: new Date(), resolvedBy: user.id },
      });
      return res.json({ success: true, data: { changeSetId: id, status: "rejected" } });
    } catch (e) {
      return res.status(500).json({
        success: false,
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    }
  },
};
