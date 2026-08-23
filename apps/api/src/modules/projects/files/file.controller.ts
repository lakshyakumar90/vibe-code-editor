import type { Request, Response } from "express";
import {
  upsertFileSchema,
  filePathSchema,
  updateFileSchema,
  moveFileSchema,
} from "./file.validation";
import { z } from "zod";
import { fileService } from "./file.service";
import { listSessions } from "better-auth/api";

export const fileController = {
  async listFiles(req: Request, res: Response) {
    try {
      const { projectId } = req.params;

      if (typeof projectId !== "string") {
        res.status(400).json({ error: "Invalid or missing project ID" });
        return;
      }

      const files = await fileService.listAllFiles(projectId);

      if (!files) {
        res.status(404).json({ error: "Files not found" });
        return;
      }

      res.json(files);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ errors: error.issues });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async getFile(req: Request, res: Response) {
    try {
      const { projectId, path } = filePathSchema.parse({
        projectId: req.params.projectId,
        path: req.query.path,
      });

      if (typeof projectId !== "string") {
        res.status(400).json({ error: "Invalid or missing project ID" });
        return;
      }

      const file = await fileService.getFileByPath(projectId, path);

      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      res.json(file);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ errors: error.issues });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async createFile(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      if (typeof projectId !== "string") {
        res.status(400).json({ error: "Invalid or missing project ID" });
        return;
      }
      const data = upsertFileSchema.parse(req.body);
      const file = await fileService.createFile(projectId, data);
      res.status(201).json(file);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ errors: error.issues });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async updateFile(req: Request, res: Response) {
    try {
      const { projectId, fileId } = req.params;
      if (typeof projectId !== "string" || typeof fileId !== "string") {
        res
          .status(400)
          .json({ error: "Invalid or missing project ID or file ID" });
        return;
      }
      const data = updateFileSchema.parse(req.body);
      const file = await fileService.updateFile(fileId, projectId, data);
      res.json(file);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ errors: error.issues });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async deleteFile(req: Request, res: Response) {
    try {
      const { projectId, fileId } = req.params;
      if (typeof projectId !== "string" || typeof fileId !== "string") {
        res
          .status(400)
          .json({ error: "Invalid or missing project ID or file ID" });
        return;
      }
      await fileService.deleteFile(fileId, projectId);
      res.status(204).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ errors: error.issues });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async moveFile(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      const { fileId } = req.query;
      if (typeof projectId !== "string" || typeof fileId !== "string") {
        res
          .status(400)
          .json({ error: "Invalid or missing project ID or file ID" });
        return;
      }
      const data = moveFileSchema.parse(req.body);
      const file = await fileService.moveFile(
        projectId,
        fileId,
        data.parentId ?? null,
        data.name,
      );
      res.json(file);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ errors: error.issues });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  },
};
