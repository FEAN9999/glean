import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.SANG_API ?? 'http://127.0.0.1:4318';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5318,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/media': { target: API },
      '/demo-forum': { target: API },
    },
  },
});
