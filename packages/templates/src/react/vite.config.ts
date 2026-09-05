import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `server.host: true` binds 0.0.0.0 so the dev server is reachable
// through WebContainer port-forwarding. Port is pinned via --strictPort
// so a clash fails loudly instead of silently shifting ports.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 5173,
    strictPort: true,
  },
});
