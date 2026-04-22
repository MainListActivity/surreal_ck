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
    views: {
      mainview: {
        entrypoint: "src/renderer/main.ts",
      },
    },
    copy: {
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
