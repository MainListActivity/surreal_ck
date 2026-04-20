import type { ElectrobunConfig } from "electrobun/bun";

const config: ElectrobunConfig = {
  app: {
    name: "SurrealCK",
    identifier: "com.surreal.ck",
    version: "0.1.0",
  },
  build: {
    bun: {
      entrypoint: "./bun/main.ts",
    },
    views: {
      main: {
        entrypoint: "./views/main/index.ts",
      },
    },
  },
};

export default config;
