import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'index.html'),
        collabSpike: resolve(__dirname, 'spike/collab-test.html'),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@surrealdb/wasm'],
  },
});
