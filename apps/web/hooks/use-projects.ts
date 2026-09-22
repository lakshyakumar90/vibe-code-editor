"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectService, Project, CreateProjectData } from "@/lib/services/projects";

export const PROJECTS_KEY = ["projects"] as const;

/**
 * Single source of truth for dashboard + sidebar + starred + recent.
 * Mutations invalidate/update this cache so every consumer updates instantly
 * (no reloads, no timeouts, no duplicated useState copies).
 */
export function useProjects(options: { limit?: number } = {}) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => projectService.getAllProjects(),
  });
  const fav = useMutation({
    mutationFn: (id: string) => projectService.toggleFavorite(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: PROJECTS_KEY });
      const prev = qc.getQueryData<Project[]>(PROJECTS_KEY);
      qc.setQueryData<Project[]>(PROJECTS_KEY, (old = []) =>
        old.map((p) => (p.id === id ? { ...p, isFavorite: !p.isFavorite } : p)),
      );
      return { prev };
    },
    onSuccess: (res, id) => {
      qc.setQueryData<Project[]>(PROJECTS_KEY, (old = []) =>
        old.map((p) => (p.id === id ? { ...p, isFavorite: res.isFavorite } : p)),
      );
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(PROJECTS_KEY, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
  const all = query.data ?? [];
  return {
    projects: options.limit ? all.slice(0, options.limit) : all,
    loading: query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refetch: async () => {
      await query.refetch();
    },
    toggleFavorite: (id: string) => fav.mutateAsync(id).then(() => undefined),
  };
}

export function useProject(id: string) {
  const { projects, loading, error, refetch, toggleFavorite } = useProjects();
  const project = projects.find((p) => p.id === id) ?? null;
  return {
    project,
    loading,
    error,
    refetch,
    toggleFavorite: () => (project ? toggleFavorite(project.id) : Promise.resolve()),
  };
}

export function useCreateProject() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (data: CreateProjectData) => projectService.createProject(data),
    onSuccess: (created) => {
      qc.setQueryData<Project[]>(PROJECTS_KEY, (old = []) => [created, ...old]);
      qc.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
  return {
    createProject: (data: CreateProjectData) => m.mutateAsync(data),
    loading: m.isPending,
    error: m.error ? (m.error as Error).message : null,
  };
}
