import { defineConfig } from 'vite';

// base './' keeps every asset path relative, so the build works from any
// GitHub Pages sub-path (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 800 }, // three.js alone is ~480 kB
  server: { port: 5173 },
});
