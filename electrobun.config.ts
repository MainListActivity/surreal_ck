import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "SurrealCK",
    identifier: "com.surreal.ck",
    version: "0.1.0",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/main/index.ts",
    },
    copy: {
      "dist/bun/surrealdb-node.darwin-arm64.node": "bun/surrealdb-node.darwin-arm64.node",
      "dist/bun/schema": "bun/schema",
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    mac: {
      bundleCEF: false,
      codesign: false,
      notarize: false,
    },
  },
} satisfies ElectrobunConfig;
