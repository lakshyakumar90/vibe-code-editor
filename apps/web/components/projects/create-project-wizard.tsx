"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@repo/ui";
import { useCreateProject } from "@/hooks/use-projects";
import { TEMPLATE_CATALOG, type TemplateId } from "@/lib/templates-catalog";
import { wizardValidation } from "@/lib/wizard-validation";
import { api } from "@/lib/api";

const STEPS = ["Basics", "Template", "Team", "GitHub"] as const;

interface Member {
  id: string;
  name: string | null;
  email: string;
}

/** Single 4-step centered modal wizard (replaces the right-side sheet). */
export function CreateProjectWizard({
  open,
  onOpenChange,
  initialTemplate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialTemplate?: TemplateId;
}) {
  const [step, setStep] = useState(initialTemplate ? 0 : 0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<TemplateId | null>(initialTemplate ?? null);
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Member[]>([]);
  const [github, setGithub] = useState<{ connected: boolean; login: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { createProject, loading } = useCreateProject();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setStep(0);
      setError(null);
      if (initialTemplate) setTemplate(initialTemplate);
      api
        .get<{ success: boolean; data: { connected: boolean; login: string | null } }>("/api/github/status")
        .then((r) => setGithub(r.data))
        .catch(() => setGithub({ connected: false, login: null }));
    }
  }, [open, initialTemplate]);

  // Debounced, cancellable member search (name or email).
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      abort.current?.abort();
      const c = new AbortController();
      abort.current = c;
      try {
        const r = await api.get<{ success: boolean; data: Member[] }>(
          `/api/users/search?q=${encodeURIComponent(query.trim())}`,
        );
        if (!c.signal.aborted) setResults(r.data);
      } catch {
        if (!c.signal.aborted) setResults([]);
      }
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  const validationError = wizardValidation(step, { name, template });

  async function finish(skipGithub = false) {
    setError(null);
    try {
      await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        template: template!,
        memberIds: members.map((m) => m.id),
      });
      void skipGithub;
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Creation failed — retry without losing your input");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="no-scrollbar max-h-[90dvh] w-[calc(100vw-2rem)] overflow-y-auto p-4 sm:max-w-2xl sm:p-6 lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <ol className="mt-2 flex flex-wrap items-center gap-1 text-xs" aria-label="Progress">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-1">
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${i === step ? "bg-primary text-primary-foreground" : i < step ? "bg-accent" : "bg-muted text-muted-foreground"}`}
                  aria-current={i === step ? "step" : undefined}
                >
                  {i + 1} {s}
                </span>
                {i < STEPS.length - 1 && <span aria-hidden>→</span>}
              </li>
            ))}
          </ol>
        </DialogHeader>

        {step === 0 && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              Project name
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                placeholder="my-app"
              />
            </label>
            <label className="block text-sm">
              Description <span className="text-muted-foreground">(optional)</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, 280))}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                rows={3}
              />
            </label>
          </div>
        )}

        {step === 1 && (
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Template">
            {TEMPLATE_CATALOG.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={template === t.id}
                onClick={() => setTemplate(t.id)}
                className={`rounded-lg border p-3 text-left ${template === t.id ? "border-primary ring-1 ring-primary" : "hover:bg-accent"}`}
              >
                <div className="text-sm font-semibold">{t.name}</div>
                <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{t.description}</div>
              </button>
            ))}
          </div>
        )}

        {step === 2 && (
          <div className="mt-4 space-y-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email…"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              aria-label="Search team members"
            />
            {results.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  if (!members.some((m) => m.id === r.id)) setMembers((p) => [...p, r]);
                  setQuery("");
                }}
                className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
              >
                <span>{r.name ?? r.email} <span className="text-muted-foreground">{r.email}</span></span>
                <span className="text-primary">Add</span>
              </button>
            ))}
            <div className="flex flex-wrap gap-1.5">
              {members.map((m) => (
                <span key={m.id} className="flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-xs">
                  {m.name ?? m.email}
                  <button onClick={() => setMembers((p) => p.filter((x) => x.id !== m.id))} aria-label={`Remove ${m.email}`}>×</button>
                </span>
              ))}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="mt-4 rounded-lg border p-4 text-sm">
            <div className="font-semibold">Connect GitHub</div>
            <p className="mt-1 text-muted-foreground">
              {github?.connected ? `GitHub connected ✓ (${github.login ?? "account"})` : "GitHub is not connected."}
            </p>
            <div className="mt-3 flex gap-2">
              {!github?.connected && (
                <a href="/api/auth/sign-in/social?provider=github" className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground">
                  Connect GitHub
                </a>
              )}
              <span className="text-xs text-muted-foreground self-center">Import-only: we never push or create repos.</span>
            </div>
          </div>
        )}

        {validationError && step < 2 && <p className="mt-3 text-xs text-red-500">{validationError}</p>}
        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

        <div className="mt-5 flex justify-between gap-2">
          <div>
            {step > 0 && (
              <button onClick={() => setStep((s) => s - 1)} className="rounded-md border px-4 py-2 text-sm" disabled={loading}>
                Back
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={() => onOpenChange(false)} className="rounded-md px-4 py-2 text-sm text-muted-foreground" disabled={loading}>
              Cancel
            </button>
            {step < 3 ? (
              <button
                onClick={() => !validationError && setStep((s) => s + 1)}
                disabled={!!validationError}
                className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
              >
                Next
              </button>
            ) : (
              <>
                <button onClick={() => void finish(true)} disabled={loading || !template || !name.trim()} className="rounded-md border px-4 py-2 text-sm disabled:opacity-50">
                  {loading ? "Creating…" : "Skip for now"}
                </button>
                <button onClick={() => void finish(false)} disabled={loading || !template || !name.trim()} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
                  {loading ? "Creating project…" : "Create Project"}
                </button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
