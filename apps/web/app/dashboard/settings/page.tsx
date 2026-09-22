"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function SettingsPage() {
  const [name, setName] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [github, setGithub] = useState<{ connected: boolean; login: string | null; scopes: { read: boolean; write: boolean } } | null>(null);
  const [avatarMsg, setAvatarMsg] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ success: boolean; data: { name: string | null } }>("/api/users/me").then((r) => setName(r.data.name ?? "")).catch(() => undefined);
    api.get<{ success: boolean; data: any }>("/api/github/status").then((r) => setGithub(r.data)).catch(() => undefined);
  }, []);

  async function save() {
    setSaveState("saving");
    try {
      await api.patch("/api/users/me", { name });
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setAvatarMsg("Uploading…");
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await api.post<{ success: boolean; data: { image: string } }>("/api/users/me/avatar", { dataUrl: reader.result });
        setAvatarMsg("Avatar updated ✓");
        void res;
      } catch {
        setAvatarMsg("Upload failed — profile unchanged");
      }
    };
    reader.readAsDataURL(f);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="mt-6 rounded-xl border p-5" aria-label="Profile">
        <h2 className="font-semibold">Profile</h2>
        <label className="mt-3 block text-sm">Display name
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-md border bg-background px-3 py-2" />
        </label>
        <label className="mt-3 block text-sm">Avatar (PNG/JPEG/WebP, &lt;2MB)
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} className="mt-1 block text-sm" />
        </label>
        {avatarMsg && <p className="mt-1 text-xs text-muted-foreground">{avatarMsg}</p>}
        <button onClick={save} className="mt-3 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : saveState === "error" ? "Error — retry" : "Save"}
        </button>
      </section>
      <section className="mt-4 rounded-xl border p-5" aria-label="Appearance">
        <h2 className="font-semibold">Appearance</h2>
        <p className="mt-1 text-sm text-muted-foreground">Theme follows the navbar toggle and persists across reloads.</p>
      </section>
      <section className="mt-4 rounded-xl border p-5" aria-label="Connected accounts">
        <h2 className="font-semibold">Connected accounts</h2>
        <ul className="mt-2 space-y-1 text-sm">
          <li>Email + Password — Connected</li>
          <li>Google — see account</li>
          <li>GitHub — {github?.connected ? `Connected (${github.login ?? ""})` : "Not connected"}</li>
        </ul>
      </section>
      <section className="mt-4 rounded-xl border p-5" aria-label="GitHub permissions">
        <h2 className="font-semibold">GitHub permissions</h2>
        <p className="mt-1 text-sm">Repository read: {github?.scopes.read ? "✓ Enabled" : "Not granted"}</p>
        <p className="text-sm">Repository write: {github?.scopes.write ? "✓ Enabled" : "Not granted"}</p>
        {github && !github.scopes.write && (
          <p className="mt-2 text-sm text-muted-foreground">GitHub access is currently read-only. Some GitHub operations may be unavailable.</p>
        )}
        <a href="/api/auth/sign-in/social?provider=github" className="mt-3 inline-block rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">Update permissions</a>
      </section>
      <section className="mt-4 rounded-xl border p-5" aria-label="Password">
        <h2 className="font-semibold">Password</h2>
        <p className="mt-1 text-sm text-muted-foreground">Use the emailed sign-in flow to rotate credentials; OAuth-only accounts show password as not enabled.</p>
      </section>
    </div>
  );
}
