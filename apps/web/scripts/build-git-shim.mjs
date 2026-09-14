/**
 * Bundles the terminal git shim (isomorphic-git CLI) for the WebContainer.
 * Output: public/vibe/git-shim.cjs — fetched by the browser at boot and
 * written into the container FS. No secrets; safe to serve statically.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(root, "..");

mkdirSync(path.join(webDir, "public", "vibe"), { recursive: true });

await build({
  entryPoints: [path.join(webDir, "lib", "webcontainer", "shim", "git-shim.ts")],
  bundle: true,
  minify: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: path.join(webDir, "public", "vibe", "git-shim.cjs"),
  banner: {
    js: "// vibe terminal git shim (isomorphic-git, local-only; no credentials)\n",
  },
  logLevel: "info",
});
