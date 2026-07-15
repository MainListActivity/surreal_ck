import { describe, expect, test } from "bun:test";
import { loadEnv } from "./env";

const requiredEnv = {
  SURREAL_URL: "ws://localhost:8000/rpc",
  SURREAL_ROOT_USER: "root",
  SURREAL_ROOT_PASS: "root",
  OIDC_ISSUER: "https://idp.example.test",
  OIDC_JWKS_URL: "https://idp.example.test/jwks.json",
  OIDC_AUDIENCE: "surreal-ck",
  IDP_HOOK_SECRET: "test-hook-secret",
};

describe("loadEnv template pack selection", () => {
  test("未配置模板包时返回空选择", () => {
    expect(loadEnv(requiredEnv).WORKSPACE_TEMPLATE_PACKS).toEqual([]);
  });

  test("按配置顺序解析并去重模板包名", () => {
    expect(
      loadEnv({
        ...requiredEnv,
        WORKSPACE_TEMPLATE_PACKS: " claims-demo, test-pack,claims-demo,  ",
      }).WORKSPACE_TEMPLATE_PACKS,
    ).toEqual(["claims-demo", "test-pack"]);
  });
});
