"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface FavoriteButtonProps {
  projectId: string;
  projectName?: string;
  isFavorite: boolean;
  onToggle: (id: string) => Promise<void>;
  className?: string;
}

/**
 * Reusable star toggle. Parent owns state via useProjects()/useProject()
 * toggleFavorite (optimistic); this button only invokes + toasts.
 * Always stops propagation so it can sit inside row links.
 */
export function FavoriteButton({
  projectId,
  projectName,
  isFavorite,
  onToggle,
  className,
}: FavoriteButtonProps) {
  const [busy, setBusy] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await onToggle(projectId);
    } catch {
      toast.error("Failed to update favorite");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      aria-pressed={isFavorite}
      aria-label={
        isFavorite
          ? `Remove ${projectName ?? "project"} from favorites`
          : `Add ${projectName ?? "project"} to favorites`
      }
      title={isFavorite ? "Remove from favorites" : "Add to favorites"}
      className={cn(
        "rounded-md p-1.5 transition-colors disabled:opacity-50",
        isFavorite
          ? "text-yellow-500 hover:text-yellow-600"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <Star
        className={cn("size-4", isFavorite && "fill-yellow-500")}
      />
    </button>
  );
}
