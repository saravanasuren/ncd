import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // API runs on :3030 in dev; SPA calls /api/* same-origin.
      '/api': { target: 'http://localhost:3030', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
