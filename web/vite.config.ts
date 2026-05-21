import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";

function sanitizeChunkName(name: string) {
  return name.replace(/\.html(?=[-_]|$)/g, "-html");
}

export default defineConfig({
  base: "./",
  root: "src/renderer",
  plugins: [
    svelte({
      compilerOptions: {
        runes: true,
      },
    }),
    viteStaticCopy({
      targets: [
        // SurrealDB native binding — must sit next to app/bun/index.js at runtime
        // so that createRequire(import.meta.url) resolves the relative .node path.
        {
          src: "../../node_modules/@surrealdb/node/dist/surrealdb-node.darwin-arm64.node",
          dest: "bun",
          rename: { stripBase: true },
        },
        // SurrealQL schema files for main-process DB initialization
        {
          src: "../../schema",
          dest: "bun",
        },
      ],
    }),
  ],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: "index.html",
      output: {
        chunkFileNames: (chunkInfo) => {
          const name = sanitizeChunkName(chunkInfo.name ?? "chunk");
          return `assets/${name}-[hash].js`;
        },
        entryFileNames: (chunkInfo) => {
          const name = sanitizeChunkName(chunkInfo.name ?? "entry");
          return `assets/${name}-[hash].js`;
        },
      },
    },
  },
});
