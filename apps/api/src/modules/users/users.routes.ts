import { Router } from "express";
import { authenticate } from "@repo/auth";
import { ProjectRepository } from "../projects/project.repository.js";
import { RedisService } from "../../lib/redis.js";
import { CacheKeys, TTL, invalidateUserProfile } from "../../lib/cache-keys.js";
import { validateAvatarUpload, uploadAvatar } from "../../lib/cloudinary.js";

const router = Router();
router.use(authenticate);

/** Debounced client-side; server caps + auth-scoped. Returns minimal fields only. */
router.get("/search", async (req: any, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  if (q.length < 2) return res.json({ success: true, data: [] });
  try {
    // Reuse repository user lookup; extend with prefix search via prisma if available.
    const byEmail = await ProjectRepository.getUserByEmail(q).catch(() => null);
    const out = byEmail
      ? [{ id: (byEmail as any).id, name: (byEmail as any).name ?? null, email: (byEmail as any).email, image: (byEmail as any).image ?? null }]
      : [];
    return res.json({ success: true, data: out });
  } catch {
    return res.status(500).json({ success: false, code: "SEARCH_FAILED", message: "Search failed" });
  }
});

router.get("/me", async (req: any, res) => {
  const key = CacheKeys.userProfile(req.user!.id);
  const hit = await RedisService.get(key);
  if (hit) return res.json({ success: true, data: hit, cached: true });
  const user = await ProjectRepository.getUserByEmail(req.user!.email ?? "").catch(() => null);
  const profile = user
    ? { id: (user as any).id, name: (user as any).name, email: (user as any).email, image: (user as any).image ?? null }
    : { id: req.user!.id, name: null, email: null, image: null };
  await RedisService.set(key, profile, TTL.profile);
  return res.json({ success: true, data: profile });
});

router.patch("/me", async (req: any, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 60) : "";
  if (!name) return res.status(400).json({ success: false, code: "INVALID_NAME", message: "Name is required" });
  try {
    const { prisma } = await import("@repo/db");
    await (prisma as any).user.update({ where: { id: req.user!.id }, data: { name } });
    await invalidateUserProfile(req.user!.id);
    return res.json({ success: true, data: { name } });
  } catch {
    return res.status(500).json({ success: false, code: "UPDATE_FAILED", message: "Could not update profile" });
  }
});

/** Avatar: JSON { dataUrl } -> server validates -> Cloudinary -> DB url. Secret never exposed. */
router.post("/me/avatar", async (req: any, res) => {
  const dataUrl = req.body?.dataUrl;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return res.status(400).json({ success: false, code: "INVALID_IMAGE", message: "Invalid image" });
  }
  const m = dataUrl.match(/^data:(image\/(png|jpeg|webp));base64,(.+)$/);
  if (!m) return res.status(400).json({ success: false, code: "INVALID_IMAGE", message: "Only PNG, JPEG, WebP allowed" });
  const buf = Buffer.from(m[3]!, "base64");
  const err = validateAvatarUpload(m[1]!, buf.length);
  if (err) return res.status(400).json({ success: false, code: "INVALID_IMAGE", message: err });
  try {
    const url = await uploadAvatar(buf, m[1]!);
    const { prisma } = await import("@repo/db");
    await (prisma as any).user.update({ where: { id: req.user!.id }, data: { image: url } });
    await invalidateUserProfile(req.user!.id);
    return res.json({ success: true, data: { image: url } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "CLOUDINARY_NOT_CONFIGURED")
      return res.status(503).json({ success: false, code: msg, message: "Avatar uploads are not configured" });
    return res.status(502).json({ success: false, code: "UPLOAD_FAILED", message: "Avatar upload failed, profile unchanged" });
  }
});

export { router as usersRouter };
