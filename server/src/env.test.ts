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

  test("TYPESAFE_API_KEY：缺省、空串与 UNSET 哨兵均按未配置处理，普通非空值原样保留", () => {
    expect(loadEnv(requiredEnv).TYPESAFE_API_KEY).toBeUndefined();
    expect(loadEnv({ ...requiredEnv, TYPESAFE_API_KEY: "" }).TYPESAFE_API_KEY).toBeUndefined();
    expect(loadEnv({ ...requiredEnv, TYPESAFE_API_KEY: "UNSET" }).TYPESAFE_API_KEY).toBeUndefined();
    expect(loadEnv({ ...requiredEnv, TYPESAFE_API_KEY: "unset" }).TYPESAFE_API_KEY).toBe("unset");
    expect(loadEnv({ ...requiredEnv, TYPESAFE_API_KEY: "real-key" }).TYPESAFE_API_KEY).toBe("real-key");
  });

  test("Mastra 遥测缺省关闭（MASTRA_TELEMETRY_DISABLED=1），只有显式 0 才放行，其他值拒绝", () => {
    expect(loadEnv(requiredEnv).MASTRA_TELEMETRY_DISABLED).toBe("1");
    expect(loadEnv({ ...requiredEnv, MASTRA_TELEMETRY_DISABLED: "0" }).MASTRA_TELEMETRY_DISABLED).toBe("0");
    // loadEnv 校验失败会把 process.exitCode 置 1 并抛错；恢复它，避免污染测试进程的退出码。
    // bun 里把 exitCode 置回 undefined 不能清零，必须给数值 0（真实失败仍由 bun 的失败计数置 1）。
    const exitCodeBefore = process.exitCode;
    try {
      expect(() => loadEnv({ ...requiredEnv, MASTRA_TELEMETRY_DISABLED: "true" })).toThrow();
    } finally {
      process.exitCode = exitCodeBefore ?? 0;
    }
  });
});

describe("loadEnv funnel hash key", () => {
  test("未配置时为 undefined（聚合任务只重算不写入）", () => {
    expect(loadEnv(requiredEnv).FUNNEL_HASH_KEY).toBeUndefined();
  });

  test("空串等价未配置：docker-compose 注入 FUNNEL_HASH_KEY= 不导致启动失败", () => {
    expect(loadEnv({ ...requiredEnv, FUNNEL_HASH_KEY: "" }).FUNNEL_HASH_KEY).toBeUndefined();
  });

  test("≥16 字符的密钥原样保留", () => {
    const key = "0123456789abcdef";
    expect(loadEnv({ ...requiredEnv, FUNNEL_HASH_KEY: key }).FUNNEL_HASH_KEY).toBe(key);
  });

  test("过短的密钥仍被拒绝", () => {
    // loadEnv 失败时会把 process.exitCode 置 1。Bun 里把 exitCode 赋回 undefined
    // 不会清除已设的 1（实测仍以 1 退出），必须显式还原为 0，否则整轮测试全绿
    // 也会以 exit 1 结束（CI Quality gate 回归）。
    const previousExitCode = process.exitCode ?? 0;
    try {
      expect(() => loadEnv({ ...requiredEnv, FUNNEL_HASH_KEY: "too-short" })).toThrow();
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
