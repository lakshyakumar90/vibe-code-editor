import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface TemplateManifest {
  id: "REACT" | "VUE" | "HONO" | "EXPRESS" | "NEXTJS" | "ANGULAR";
  name: string;
  version: string;
  dir: string;
  entry: string;
  description?: string;
}

export interface TemplateFile {
  /** posix-style relative path, e.g. "src/App.tsx" */
  path: string;
  content: string;
  isFolder: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(HERE, "..", "manifests");
const SRC_DIR = join(HERE);

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".bolt"]);

export function listManifests(): TemplateManifest[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(MANIFESTS_DIR, f), "utf8")) as TemplateManifest);
}

export function getManifest(id: TemplateManifest["id"]): TemplateManifest {
  const lower = id.toLowerCase();
  const raw = readFileSync(join(MANIFESTS_DIR, `${lower}.json`), "utf8");
  return JSON.parse(raw) as TemplateManifest;
}

/** Walk template dir on disk, return folders-first file list for DB seeding. */
export function getTemplateFiles(id: TemplateManifest["id"]): TemplateFile[] {
  const manifest = getManifest(id);
  const root = join(SRC_DIR, manifest.dir);
  const out: TemplateFile[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const abs = join(dir, entry);
      const rel = relative(root, abs).split(sep).join("/");
      if (statSync(abs).isDirectory()) {
        out.push({ path: rel, content: "", isFolder: true });
        walk(abs);
      } else {
        out.push({ path: rel, content: readFileSync(abs, "utf8"), isFolder: false });
      }
    }
  }

  walk(root);
  out.sort((a, b) => Number(a.isFolder) - Number(b.isFolder) || (a.path < b.path ? -1 : 1));
  return out;
}
