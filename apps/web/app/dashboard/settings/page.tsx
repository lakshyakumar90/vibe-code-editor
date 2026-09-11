import { Suspense } from "react";
import { GitHubConnectionCard } from "@/components/settings/github-connection-card";

export default function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage workspace integrations. GitHub is optional — the IDE works
          normally without it.
        </p>
      </div>
      <section aria-label="Integrations" className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-muted-foreground">Integrations</h2>
        <Suspense fallback={<div className="text-sm text-muted-foreground">Loading…</div>}>
          <GitHubConnectionCard />
        </Suspense>
      </section>
    </div>
  );
}
