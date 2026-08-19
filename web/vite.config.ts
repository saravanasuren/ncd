import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Ports are overridable so parallel co-work worktrees can each run a dev server
// without fighting over one port (ops/cowork.sh writes .env.cowork per tree).
// Defaults are the long-standing 5173/3030, so the main checkout is unchanged.
const webPort = Number(process.env.NCD_WEB_PORT ?? 5173);
const apiPort = Number(process.env.NCD_API_PORT ?? 3030);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    // Fail loudly rather than silently sliding to 5174 — a proxy pointing at
    // the wrong session's API is the confusing failure we are removing.
    strictPort: true,
    proxy: {
      // The SPA calls /api/* same-origin; vite forwards to this tree's API.
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
