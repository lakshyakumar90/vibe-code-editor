/** Server-side Cloudinary helper. Secret never leaves the server. */

export function isCloudinaryConfigured(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET,
  );
}

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export function validateAvatarUpload(mime: string, bytes: number): string | null {
  if (!ALLOWED.has(mime)) return "Only PNG, JPEG, or WebP avatars are allowed";
  if (bytes <= 0 || bytes > AVATAR_MAX_BYTES) return "Avatar must be under 2MB";
  return null;
}

/** Upload a data-URL/base64 image buffer to Cloudinary, return secure_url. */
export async function uploadAvatar(buffer: Buffer, mime: string): Promise<string> {
  if (!isCloudinaryConfigured()) throw new Error("CLOUDINARY_NOT_CONFIGURED");
  const cloud = process.env.CLOUDINARY_CLOUD_NAME!;
  const key = process.env.CLOUDINARY_API_KEY!;
  const secret = process.env.CLOUDINARY_API_SECRET!;
  // Signed upload via REST: build signature server-side, secret never exposed.
  const crypto = await import("node:crypto");
  const timestamp = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = {
    timestamp: String(timestamp),
    folder: "vibe/avatars",
    transformation: "c_fill,w_256,h_256,g_face",
  };
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const signature = crypto.createHash("sha1").update(toSign + secret).digest("hex");
  const form = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mime });
  form.append("file", blob, "avatar");
  form.append("api_key", key);
  form.append("timestamp", String(timestamp));
  form.append("folder", "vibe/avatars");
  form.append("transformation", "c_fill,w_256,h_256,g_face");
  form.append("signature", signature);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("AVATAR_UPLOAD_FAILED");
  const json = (await res.json()) as { secure_url?: string };
  if (!json.secure_url) throw new Error("AVATAR_UPLOAD_FAILED");
  return json.secure_url;
}
