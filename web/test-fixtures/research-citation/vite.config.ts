import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
const fixture = (name: string) => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({ root: fixture("."), plugins: [svelte({ compilerOptions: { runes: true } })],
  resolve: { alias: [
    { find: "../lib/workspace-store.svelte", replacement: fixture("mocks.ts") },
    { find: "../lib/content-reader-browser", replacement: fixture("mocks.ts") },
  ] }, server: { host: "127.0.0.1", port: 18524, strictPort: true, fs: { allow: [fixture("../../..")] } } });
