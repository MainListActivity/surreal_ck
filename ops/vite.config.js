import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // 生产同域子路径发布：web Pages 项目把本包静态产物挂到 /ops/；
  // 本地 dev/preview 缺省 / 不受影响。
  base: process.env.VITE_OPS_BASE || "/",
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        callback: resolve(import.meta.dirname, "auth/callback.html"),
      },
    },
  },
});
