"use client";

import { useState } from "react";
import { TEMPLATE_CATALOG } from "@/lib/templates-catalog";
import { CreateProjectWizard } from "@/components/projects/create-project-wizard";

export default function TemplatesPage() {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<(typeof TEMPLATE_CATALOG)[number]["id"] | undefined>(undefined);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">Templates</h1>
      <p className="mt-1 text-sm text-muted-foreground">Six supported stacks. Pick one to create a project.</p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TEMPLATE_CATALOG.map((t) => (
          <div key={t.id} className="flex h-full flex-col rounded-xl border p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-lg font-bold" aria-hidden>
              {t.name[0]}
            </div>
            <h2 className="mt-3 font-semibold">{t.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {t.tech.map((x) => (
                <span key={x} className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{x}</span>
              ))}
            </div>
            <ul className="mt-3 space-y-0.5 text-xs text-muted-foreground">
              <li className="font-medium text-foreground">Includes</li>
              {t.files.map((f) => (
                <li key={f} className="font-mono">• {f}</li>
              ))}
            </ul>
            <div className="flex-1" />
            <button
              onClick={() => {
                setPreset(t.id);
                setOpen(true);
              }}
              className="mt-4 w-full rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
            >
              Create Project
            </button>
          </div>
        ))}
      </div>
      <CreateProjectWizard open={open} onOpenChange={setOpen} initialTemplate={preset} />
    </div>
  );
}
