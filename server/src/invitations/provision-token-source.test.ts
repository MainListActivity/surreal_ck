import { describe, expect, test } from "bun:test";
import { PlatformSecretError } from "../platform/secret-store";
import {
  createIdpAdminClientSource,
  createProvisionTokenSource,
  IDP_PROVISION_TOKEN_SECRET_NAME,
} from "./idp-admin-client";

type Stored = { value: string; updatedAt: string | null; updatedBy: string } | null;

function memStore(initial: Stored = null) {
  let row = initial;
  return {
    async get(name: string) {
      return name === IDP_PROVISION_TOKEN_SECRET_NAME ? row : null;
    },
    set(next: Stored) {
      row = next;
    },
  };
}

describe("ProvisionTokenSource 优先级", () => {
  test("密封行存在 → store 优先，env 兜底值不复活", async () => {
    const source = createProvisionTokenSource({
      secretStore: memStore({ value: "tok-store", updatedAt: null, updatedBy: "ops" }),
      envToken: "tok-env",
    });
    expect(await source()).toEqual({ token: "tok-store", source: "store" });
  });

  test("无密封行 → 回退 IDP_PROVISION_TOKEN（bootstrap/应急兜底）", async () => {
    const source = createProvisionTokenSource({ secretStore: memStore(), envToken: "tok-env" });
    expect(await source()).toEqual({ token: "tok-env", source: "env" });
  });

  test("密封仓未装配（PLATFORM_SECRET_KEY 缺省）→ 同样回退 env", async () => {
    const source = createProvisionTokenSource({ secretStore: null, envToken: "tok-env" });
    expect(await source()).toEqual({ token: "tok-env", source: "env" });
  });

  test("两者皆无 → null（调用方 fail closed）", async () => {
    expect(await createProvisionTokenSource({ secretStore: memStore() })()).toBeNull();
    expect(await createProvisionTokenSource({ secretStore: null })()).toBeNull();
  });

  test("密封行解封失败 → 错误上抛，不静默回退 env", async () => {
    const broken = {
      async get() {
        throw new PlatformSecretError("secret-unseal-failed", "解封失败");
      },
    };
    const source = createProvisionTokenSource({ secretStore: broken, envToken: "tok-env" });
    await expect(source()).rejects.toMatchObject({ code: "secret-unseal-failed" });
  });
});

describe("IdpAdminClientSource 懒解析（轮换即刻生效）", () => {
  const authLog: (string | null)[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    authLog.push(new Headers(init?.headers).get("authorization"));
    return new Response(JSON.stringify({ tenants: [{ id: "t-1", slug: "ck" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  test("同一 source 两次解析分别携带轮换前/后的 token", async () => {
    authLog.length = 0;
    const store = memStore({ value: "tok-A", updatedAt: null, updatedBy: "ops" });
    const source = createIdpAdminClientSource({
      tokenSource: createProvisionTokenSource({ secretStore: store, envToken: "tok-env" }),
      baseUrl: "https://o.maplayer.top",
      tenantSlug: "ck",
      fetchImpl,
    });
    const before = await source();
    await before!.probe();
    store.set({ value: "tok-B", updatedAt: null, updatedBy: "ops" });
    const after = await source();
    await after!.probe();
    expect(authLog).toEqual(["Bearer tok-A", "Bearer tok-B"]);
  });

  test("token 源解析为 null → 客户端为 null（fail closed）", async () => {
    const source = createIdpAdminClientSource({
      tokenSource: async () => null,
      baseUrl: "https://o.maplayer.top",
      tenantSlug: "ck",
      fetchImpl,
    });
    expect(await source()).toBeNull();
  });
});
