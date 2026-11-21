import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Staff dashboard. Built into admin/dist and served by the API at /admin, so
// both asset URLs and the dev server live under the /admin/ base path.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 3001,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: false,
      },
    },
  },
});
