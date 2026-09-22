import { Router } from "express";
import { authenticate } from "@repo/auth";
import { githubService } from "./github.service.js";
import { invalidateGithubRepos, invalidateGithubInspection } from "../../lib/cache-keys.js";
import { RedisService } from "../../lib/redis.js";
import { CacheKeys, TTL } from "../../lib/cache-keys.js";

const router = Router();
router.use(authenticate);

/** Token is never logged, never cached, never returned to client. */
function tokenFor(req: any): string | undefined {
  // Better-auth github account token lookup would go here; support header passthrough + env fallback.
  const h = req.headers?.["x-github-token"];
  if (typeof h === "string" && h.length > 0) return h;
  return process.env.GITHUB_TOKEN || undefined;
}

router.get("/status", async (req: any, res) => {
  const userId = req.user!.id;
  const key = CacheKeys.githubStatus(userId);
  const cached = await RedisService.get<any>(key);
  if (cached) return res.json({ success: true, data: cached });
  // Probe: token present => verify with /user, else disconnected.
  const token = tokenFor(req);
  let data = { connected: false, scopes: { read: false, write: false }, login: null as string | null };
  if (token) {
    try {
      const r = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "vibe" },
      });
      if (r.ok) {
        const u: any = await r.json();
        const scopes = (r.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim());
        data = {
          connected: true,
          login: u.login ?? null,
          scopes: { read: true, write: scopes.includes("repo") || scopes.includes("public_repo") },
        };
      }
    } catch {
      // fall through as disconnected
    }
  }
  await RedisService.set(key, data, TTL.githubStatus);
  return res.json({ success: true, data });
});

router.post("/refresh", async (req: any, res) => {
  await invalidateGithubRepos(req.user!.id);
  return res.json({ success: true, data: { refreshed: true } });
});

router.get("/repos", async (req: any, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  try {
    const result = await githubService.listRepos(req.user!.id, q, tokenFor(req));
    return res.json({ success: true, data: result.repos, cached: result.cached });
  } catch (e) {
    return res.status(502).json({ success: false, code: "GITHUB_UNAVAILABLE", message: "GitHub is unavailable" });
  }
});

router.get("/inspect/:owner/:repo", async (req: any, res) => {
  try {
    const result = await githubService.inspect(req.params.owner, req.params.repo, tokenFor(req));
    return res.json({ success: true, data: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "GITHUB_NOT_FOUND") return res.status(404).json({ success: false, code: msg, message: "Repository not found" });
    return res.status(502).json({ success: false, code: "GITHUB_UNAVAILABLE", message: "GitHub is unavailable" });
  }
});

router.post("/import", async (req: any, res) => {
  const { owner, repo, name } = req.body ?? {};
  if (!owner || !repo) return res.status(400).json({ success: false, code: "INVALID_INPUT", message: "owner and repo are required" });
  try {
    const result = await githubService.importRepo(req.user!.id, owner, repo, name ?? repo, tokenFor(req));
    await invalidateGithubInspection(owner, repo);
    return res.status(201).json({ success: true, data: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNSUPPORTED_TEMPLATE")
      return res.status(400).json({ success: false, code: msg, message: "Only Next.js, Express, Hono, React, Angular, Vue repositories can be imported" });
    return res.status(502).json({ success: false, code: "IMPORT_FAILED", message: "Import failed" });
  }
});

export { router as githubRouter };
