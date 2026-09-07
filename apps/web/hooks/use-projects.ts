"use client";

import { useState, useEffect, useCallback } from "react";
import { projectService, Project, CreateProjectData } from "@/lib/services/projects";

/**
 * Optimistic star toggle shared by list + detail hooks: flips immediately,
 * confirms against POST /:id/favorite, rolls back on failure.
 */
function useToggleFavorite(
  apply: (updater: (prev: Project[]) => Project[]) => void,
) {
  return useCallback(
    async (id: string) => {
      apply((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, isFavorite: !p.isFavorite } : p,
        ),
      );
      try {
        const res = await projectService.toggleFavorite(id);
        apply((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, isFavorite: res.isFavorite } : p,
          ),
        );
      } catch {
        apply((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, isFavorite: !p.isFavorite } : p,
          ),
        );
        throw new Error("Failed to update favorite");
      }
    },
    [apply],
  );
}

interface UseProjectsOptions {
  limit?: number;
}

interface UseProjectsReturn {
  projects: Project[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
}

export function useProjects(options: UseProjectsOptions = {}): UseProjectsReturn {
  const { limit } = options;
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await projectService.getAllProjects();
      setProjects(limit ? data.slice(0, limit) : data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch projects");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return {
    projects,
    loading,
    error,
    refetch: fetchProjects,
    toggleFavorite: useToggleFavorite(setProjects),
  };
}

interface UseProjectReturn {
  project: Project | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  toggleFavorite: () => Promise<void>;
}

export function useProject(id: string): UseProjectReturn {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProject = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await projectService.getProjectById(id);
      setProject(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch project");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) {
      fetchProject();
    }
  }, [id, fetchProject]);

  const toggleFavorite = useToggleFavorite(
    useCallback(
      (updater: (prev: Project[]) => Project[]) => {
        setProject((prev) => {
          if (!prev) return prev;
          return updater([prev])[0] ?? prev;
        });
      },
      [],
    ),
  );

  return {
    project,
    loading,
    error,
    refetch: fetchProject,
    toggleFavorite: useCallback(
      () => (project ? toggleFavorite(project.id) : Promise.resolve()),
      [project, toggleFavorite],
    ),
  };
}

interface UseCreateProjectReturn {
  createProject: (data: CreateProjectData) => Promise<Project>;
  loading: boolean;
  error: string | null;
}

export function useCreateProject(): UseCreateProjectReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createProject = useCallback(async (data: CreateProjectData): Promise<Project> => {
    try {
      setLoading(true);
      setError(null);
      const project = await projectService.createProject(data);
      return project;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create project";
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    createProject,
    loading,
    error,
  };
}
