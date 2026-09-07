"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/auth/auth-guard";

/**
 * Legacy route — starred now lives on the projects page behind
 * ?filter=starred (single source of truth).
 */
export default function StarredPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/projects?filter=starred");
  }, [router]);

  return (
    <AuthGuard>
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        Redirecting to starred projects…
      </div>
    </AuthGuard>
  );
}
