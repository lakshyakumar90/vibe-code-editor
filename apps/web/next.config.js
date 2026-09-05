/** @type {import('next').NextConfig} */
const nextConfig = {
  // Step 2 — WebContainer requires cross-origin isolation (SharedArrayBuffer).
  // Scoped to the fullscreen editor route ONLY so auth/dashboard/API calls
  // elsewhere are unaffected. Restart `pnpm --filter web dev` after this.
  async headers() {
    return [
      {
        source: "/dashboard/projects/:path*",
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
