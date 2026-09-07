"use client";

import { AuthGuard } from "@/components/auth/auth-guard";
import { StarredProjects } from "@/components/dashboard/starred-projects";

export default function StarredPage() {
  return (
    <AuthGuard>
      <div className="mx-auto w-full max-w-4xl p-6">
        <StarredProjects />
      </div>
    </AuthGuard>
  );
}
