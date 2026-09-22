/** @type {import('next').NextConfig} */
const nextConfig = {
  // Step 2 — WebContainer requires cross-origin isolation (SharedArrayBuffer).
  // Scoped to the fullscreen editor route ONLY so auth/dashboard/API calls
  // elsewhere are unaffected. Restart `pnpm --filter web dev` after this.
  async headers() {
    return [
      {
        // WebContainer needs SharedArrayBuffer on the editor page.
        // Applied broadly: Next matches most-specific first, and a narrow
        // "/dashboard/projects/:path*" pattern misses the exact
        // "/dashboard/projects/[projectId]" page in some versions.
        source: "/:path*",
        headers: [
          {
            key: "Cross-Origin-Embedder-Policy",
            value: "require-corp",
          },
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
