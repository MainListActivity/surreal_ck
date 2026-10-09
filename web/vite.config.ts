import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  envDir: "..",
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  plugins: [
    {
      name: "runtime-release",
      generateBundle() {
        const sha = process.env.SCK_RELEASE_SHA;
        const deploymentId = process.env.SCK_DEPLOYMENT_ID;
        this.emitFile({ type: "asset", fileName: "runtime-version.json", source: JSON.stringify(
          sha && /^[a-f0-9]{40}$/.test(sha) && deploymentId && /^[0-9]+-[0-9]+$/.test(deploymentId)
            ? { sha, deploymentId } : { sha: null, deploymentId: null },
        ) });
      },
    },
    tailwindcss(),
    svelte({
      compilerOptions: {
        runes: true,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    entries: ["index.html"],
    exclude: ["@revolist/svelte-datagrid", "@revolist/revogrid"],
  },
  build: {
    target: "esnext",
    emptyOutDir: true,
  },
});
