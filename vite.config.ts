import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  root: "src/renderer",
  plugins: [
    svelte({
      compilerOptions: {
        runes: true,
      },
    }),
  ],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: "index.html",
    },
  },
});
