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

  test("读取平台运营 bootstrap 配置但不隐式填充权限", () => {
    const loaded = loadEnv({
      ...requiredEnv,
      PLATFORM_OPERATOR_SUBJECTS: "user-1",
      PLATFORM_OPERATOR_CAPABILITIES: "content.read,content.submit",
      PLATFORM_OPERATOR_DISPLAY_NAME: "Content Ops",
      PLATFORM_OPERATOR_GRANTOR_SUBJECT: "deploy-admin",
    });

    expect(loaded.PLATFORM_OPERATOR_SUBJECTS).toBe("user-1");
    expect(loaded.PLATFORM_OPERATOR_CAPABILITIES).toBe("content.read,content.submit");
    expect(loaded.PLATFORM_OPERATOR_DISPLAY_NAME).toBe("Content Ops");
    expect(loaded.PLATFORM_OPERATOR_GRANTOR_SUBJECT).toBe("deploy-admin");
  });

  test("债权人门户 pepper 与附件键均为可选", () => {
    const loaded = loadEnv({
      ...requiredEnv,
      CLAIMS_PORTAL_TOKEN_PEPPER: "x".repeat(32),
      CLAIMS_ATTACHMENT_ACCOUNT_ID: "acc",
      CLAIMS_ATTACHMENT_ACCESS_KEY_ID: "key",
      CLAIMS_ATTACHMENT_SECRET_ACCESS_KEY: "secret",
      CLAIMS_ATTACHMENT_BUCKET: "bucket",
      CLAIMS_ATTACHMENT_ENDPOINT: "https://r2.example",
    });
    expect(loaded.CLAIMS_PORTAL_TOKEN_PEPPER).toBe("x".repeat(32));
    expect(loaded.CLAIMS_ATTACHMENT_BUCKET).toBe("bucket");
    expect(loadEnv(requiredEnv).CLAIMS_PORTAL_TOKEN_PEPPER).toBeUndefined();
  });
});
