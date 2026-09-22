"use client";

import React, { useState } from "react";
import { CreateProjectCard } from "./create-project-card";
import { RecentProjects } from "./recent-projects";
import { StarredProjects } from "./starred-projects";
import { CreateProjectWizard } from "components/projects/create-project-wizard";

export function DashboardHome() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
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
        <CreateProjectWizard open={open} onOpenChange={setOpen} />
      </div>

      <CreateProjectCard onCreateProject={() => setOpen(true)} />

      <StarredProjects compact />

      <RecentProjects />
    </div>
  )
}