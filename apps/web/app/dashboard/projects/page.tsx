"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { AuthGuard } from "@/components/auth/auth-guard";
import { Button } from "@repo/ui/components/ui/button";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");

  useEffect(() => {
    api
      .get<{ success: boolean; data: any[] }>("/api/projects")
      .then((r) => setProjects(r.data))
      .finally(() => setLoading(false));
  }, []);

  const create = async () => {
    const res = await api.post<{ success: boolean; data: any }>(
      "/api/projects/create",
      { name },
    ); // body per project.validation.ts

    setProjects((p) => [...p, res.data]);
    setName("");
  };

  if (loading) return <div>Loading...</div>;

  return (
    <AuthGuard>
      <div className="p-6 mx-auto max-w-4xl">
        <div className="flex justify-between mb-6">
          <h1 className="text-2xl font-bold">Your Projects</h1>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New project"
              className="border px-2"
            />
            <Button onClick={create}>Create Project</Button>
          </div>
        </div>
        <div className="grid gap-4">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="border p-4 rounded hover:bg-accent"
            >
              {p.name}
            </Link>
          ))}
        </div>
      </div>
    </AuthGuard>
  );
}
