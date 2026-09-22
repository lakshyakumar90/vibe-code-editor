/** Single source of truth for template metadata (Templates page + wizard). */
export type TemplateId = "NEXTJS" | "EXPRESS" | "HONO" | "REACT" | "ANGULAR" | "VUE";

export interface TemplateMeta {
  id: TemplateId;
  name: string;
  description: string;
  tech: string[];
  files: string[];
}

export const TEMPLATE_CATALOG: TemplateMeta[] = [
  { id: "NEXTJS", name: "Next.js", description: "Full-stack React framework with App Router.", tech: ["React", "TypeScript"], files: ["app/page.tsx", "package.json"] },
  { id: "REACT", name: "React", description: "Modern React application with Vite and TypeScript.", tech: ["React", "Vite"], files: ["src/", "public/", "package.json", "index.html"] },
  { id: "EXPRESS", name: "Express", description: "Minimal Node.js API server.", tech: ["Node.js", "Express"], files: ["src/index.js", "package.json"] },
  { id: "HONO", name: "Hono", description: "Ultrafast edge-friendly web framework.", tech: ["Hono", "TS"], files: ["src/index.ts", "package.json"] },
  { id: "VUE", name: "Vue", description: "Progressive Vue 3 app with Vite.", tech: ["Vue 3", "Vite"], files: ["src/", "package.json"] },
  { id: "ANGULAR", name: "Angular", description: "Enterprise Angular application.", tech: ["Angular", "TS"], files: ["src/", "angular.json"] },
];
