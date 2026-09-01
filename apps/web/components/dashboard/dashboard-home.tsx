"use client";

import React, { useState } from "react";
import { CreateProjectCard } from "./create-project-card";
import { RecentProjects } from "./recent-projects";
import { CreateProjectSheet } from "components/projects/create-project-sheet";

export function DashboardHome() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto w-full max-w-7xl px-32 py-10">
      <div className="">
        <div className="mb-10">
          <p className="text-sm text-muted-foreground">Welcome back</p>

          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            What do you want to build?
          </h1>

          <p className="mt-2 text-muted-foreground">
            Start a new project or continue working on something you already
            started.
          </p>
        </div>
        <CreateProjectSheet
          open={open}
          onOpenChange={setOpen}
        />
      </div>

      <CreateProjectCard onCreateProject={() => setOpen(true)} />

      <RecentProjects />
    </div>
  )
}