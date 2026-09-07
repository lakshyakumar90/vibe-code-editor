"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { projectService } from "@/lib/services/projects";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

interface DeleteProjectButtonProps {
  projectId: string;
  projectName?: string;
  /** Called after a successful delete (e.g. refetch the list). */
  onDeleted?: () => void;
  /** When true, navigate to /dashboard/projects after delete. */
  redirectAfterDelete?: boolean;
  className?: string;
}

/**
 * Reusable delete with confirmation. Stops propagation for use inside
 * row links. Only render for owners (API enforces OWNER regardless).
 */
export function DeleteProjectButton({
  projectId,
  projectName,
  onDeleted,
  redirectAfterDelete = false,
  className,
}: DeleteProjectButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await projectService.deleteProject(projectId);
      toast.success("Project deleted");
      setOpen(false);
      onDeleted?.();
      if (redirectAfterDelete) {
        router.push("/dashboard/projects");
      }
    } catch {
      toast.error("Failed to delete project");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Delete ${projectName ?? "project"}`}
        title="Delete project"
        className={cn(
          "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive",
          className,
        )}
      >
        <Trash2 className="size-4" />
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete{" "}
              {projectName ? `"${projectName}"` : "this project"} and all of
              its files. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={handleConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
