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
        // electrobun webview 主入口
        main: resolve(__dirname, 'views/main/index.html'),
      },
    },
  },
  resolve: {
    alias: {
      // 在 webview 开发时，electrobun/view API 由 views/main/ipc.ts 的 IPC 客户端提供
      // 构建时 electrobun 会替换这个别名
    },
  },
  optimizeDeps: {
    // electrobun/view 是运行时注入的，排除在 vite 优化之外
    exclude: ['electrobun'],
  },
});
