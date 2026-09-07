"use client";

import { useState } from "react";
import { Settings2 } from "lucide-react";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROVIDER_MODELS,
  SUPPORTED_PROVIDERS,
  type AiProviderId,
} from "@repo/ai";

export const INLINE_PROVIDER_KEY = "inlineCompletionProvider";
export const INLINE_MODEL_KEY = "inlineCompletionModel";

function isProviderId(v: string): v is AiProviderId {
  return (Object.keys(PROVIDER_MODELS) as string[]).includes(v);
}

/** Stored inline provider/model, validated against the registry. */
export function readInlineSettings(): { provider: string; model: string } {
  if (typeof window === "undefined") {
    return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
  }
  try {
    const rawProvider = window.localStorage.getItem(INLINE_PROVIDER_KEY);
    const provider: AiProviderId =
      rawProvider && isProviderId(rawProvider) ? rawProvider : DEFAULT_PROVIDER;
    const models = PROVIDER_MODELS[provider];
    const rawModel = window.localStorage.getItem(INLINE_MODEL_KEY);
    const model =
      rawModel && models.includes(rawModel) ? rawModel : models[0] ?? DEFAULT_MODEL;
    return { provider, model };
  } catch {
    return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
  }
}

/**
 * Gear button next to the editor breadcrumb AI toggle. Provider/model
 * selects for ghost-text completions only — stored under separate
 * localStorage keys, independent from the chat panel's selection.
 */
export function InlineSettingsButton() {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<AiProviderId>(() => readInlineSettings().provider as AiProviderId);
  const [model, setModel] = useState<string>(() => readInlineSettings().model);

  const persist = (pid: AiProviderId, m: string) => {
    try {
      window.localStorage.setItem(INLINE_PROVIDER_KEY, pid);
      window.localStorage.setItem(INLINE_MODEL_KEY, m);
    } catch {
      // private mode etc. — selection still applies for this session
    }
  };

  const onProviderChange = (pid: AiProviderId) => {
    const m = PROVIDER_MODELS[pid][0] ?? DEFAULT_MODEL;
    setProvider(pid);
    setModel(m);
    persist(pid, m);
  };

  const onModelChange = (m: string) => {
    setModel(m);
    persist(provider, m);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Inline suggestions: ${SUPPORTED_PROVIDERS[provider].label} · ${model}`}
        aria-label="Inline suggestion settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="rounded border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Settings2 className="size-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Inline suggestion settings"
            className="absolute right-0 top-9 z-20 w-64 rounded-md border bg-popover p-3 shadow-md"
          >
            <div className="mb-2 text-xs font-medium">Inline suggestions</div>
            <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="inline-provider">
              Provider
            </label>
            <select
              id="inline-provider"
              value={provider}
              onChange={(e) => {
                const pid = e.target.value;
                if (isProviderId(pid)) onProviderChange(pid);
              }}
              className="mb-2 w-full rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
            >
              {(Object.keys(PROVIDER_MODELS) as AiProviderId[]).map((pid) => (
                <option key={pid} value={pid}>
                  {SUPPORTED_PROVIDERS[pid].label}
                </option>
              ))}
            </select>
            <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="inline-model">
              Model
            </label>
            <select
              id="inline-model"
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
            >
              {PROVIDER_MODELS[provider].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              Applies to ghost text only — chat uses its own picker in the agent panel.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
