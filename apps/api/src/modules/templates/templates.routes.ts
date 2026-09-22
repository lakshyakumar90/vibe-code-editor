import { Router } from "express";
import { RedisService } from "../../lib/redis.js";
import { CacheKeys, TTL } from "../../lib/cache-keys.js";

const router = Router();

const CATALOG = [
  { id: "NEXTJS", name: "Next.js", description: "Full-stack React framework with App Router.", tech: ["React", "TypeScript", "Tailwind"], files: ["app/page.tsx", "package.json", "next.config.js"], logo: "next" },
  { id: "REACT", name: "React", description: "Modern React application with Vite and TypeScript.", tech: ["React", "Vite", "TypeScript"], files: ["src/", "public/", "package.json", "index.html"], logo: "react" },
  { id: "EXPRESS", name: "Express", description: "Minimal Node.js API server.", tech: ["Node.js", "Express"], files: ["src/index.js", "package.json"], logo: "express" },
  { id: "HONO", name: "Hono", description: "Ultrafast edge-friendly web framework.", tech: ["Hono", "TypeScript"], files: ["src/index.ts", "package.json"], logo: "hono" },
  { id: "VUE", name: "Vue", description: "Progressive Vue 3 application with Vite.", tech: ["Vue 3", "Vite"], files: ["src/", "package.json", "index.html"], logo: "vue" },
  { id: "ANGULAR", name: "Angular", description: "Enterprise Angular application.", tech: ["Angular", "TypeScript"], files: ["src/", "angular.json", "package.json"], logo: "angular" },
];

router.get("/", async (_req, res) => {
  const hit = await RedisService.get(CacheKeys.templatesCatalog());
  if (hit) return res.json({ success: true, data: hit, cached: true });
  await RedisService.set(CacheKeys.templatesCatalog(), CATALOG, TTL.templates);
  return res.json({ success: true, data: CATALOG, cached: false });
});

export { router as templatesRouter };
