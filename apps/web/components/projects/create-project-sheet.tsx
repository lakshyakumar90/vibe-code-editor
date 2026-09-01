"use client";

import * as React from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/ui";

import { CreateProjectForm } from "./create-project-form";

interface CreateProjectSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProjectSheet({
  open,
  onOpenChange,
}: CreateProjectSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-lg pl-5 pt-8"
      >
        <SheetHeader className="p-0">
          <SheetTitle>Create a project</SheetTitle>

          <SheetDescription>
            Start a new project with your preferred technology
            stack.
          </SheetDescription>
        </SheetHeader>

        <CreateProjectForm
          onSuccess={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  );
}