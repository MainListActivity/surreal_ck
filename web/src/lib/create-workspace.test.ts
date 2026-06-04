import { describe, expect, test } from "bun:test";
import {
  createWorkspaceCreator,
  type CreateDeps,
} from "./create-workspace";

/** 拼一个最小可解析的 JWT：仅 payload 段有意义。 */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

type CreateOutcome =
  | { kind: "ok"; status: 200; body: { slug: string; dbName: string; accessToken: string; expiresIn: number | null } }
  | { kind: "error"; status: number; code: string; details?: { slug: string; dbName: string } };

function setup(overrides: Partial<CreateDeps> & { outcome?: CreateOutcome } = {}) {
  const calls = {
    create: [] as Array<{ name: string; slug: string }>,
    storeToken: [] as Array<{ accessToken: string; expiresIn?: number | null }>,
    enter: [] as Array<{ rawToken: string; dbName: string; role?: string; slug?: string; name?: string }>,
    navigate: [] as string[],
  };

  const outcome: CreateOutcome =
    overrides.outcome ?? {
      kind: "ok",
      status: 200,
      body: { slug: "gamma", dbName: "ws_gamma", accessToken: jwt({ "https://surrealdb.com/db": "ws_gamma" }), expiresIn: 3600 },
    };

  const deps: CreateDeps = {
    requestCreate:
      overrides.requestCreate ??
      (async (input) => {
        calls.create.push(input);
        if (outcome.kind === "ok") return outcome.body;
        const err = new Error(outcome.code) as Error & { status: number; details?: unknown };
        err.status = outcome.status;
        err.details = outcome.details;
        throw err;
      }),
    storeAccessToken:
      overrides.storeAccessToken ??
      ((accessToken, expiresIn) => {
        calls.storeToken.push({ accessToken, expiresIn });
        return accessToken;
      }),
    enterWorkspace:
      overrides.enterWorkspace ??
      (async (input) => {
        calls.enter.push(input);
      }),
    navigate: overrides.navigate ?? ((url) => calls.navigate.push(url)),
  };

  return { creator: createWorkspaceCreator(deps), calls };
}

describe("createWorkspace", () => {
  test("成功路径：POST create → storeAccessToken → enterWorkspace 新 db（admin） → URL 跳转 /w/<slug>", async () => {
    const { creator, calls } = setup();

    const result = await creator.createWorkspace({ name: "Gamma", slug: "gamma" });

    expect(result).toEqual({ ok: true });
    expect(calls.create).toEqual([{ name: "Gamma", slug: "gamma" }]);
    expect(calls.storeToken).toHaveLength(1);
    expect(calls.enter).toHaveLength(1);
    // 创建者是 owner，必然 admin；用后端返回的新 token 连后端返回的新库
    expect(calls.enter[0]).toMatchObject({
      dbName: "ws_gamma",
      role: "admin",
      slug: "gamma",
      name: "Gamma",
    });
    expect(calls.navigate).toEqual(["/w/gamma"]);
  });

  test("409 slug 冲突：返回 slug-conflict，不 storeAccessToken / enter / navigate", async () => {
    const { creator, calls } = setup({
      outcome: { kind: "error", status: 409, code: "workspace-slug-conflict" },
    });

    const result = await creator.createWorkspace({ name: "Gamma", slug: "gamma" });

    expect(result).toEqual({ ok: false, reason: "slug-conflict" });
    expect(calls.storeToken).toHaveLength(0);
    expect(calls.enter).toHaveLength(0);
    expect(calls.navigate).toHaveLength(0);
  });

  test("502 scope-update-failed：workspace 已建，返回 slug/dbName 供 UI 重试进入，不 store token / enter", async () => {
    const { creator, calls } = setup({
      outcome: {
        kind: "error",
        status: 502,
        code: "scope-update-failed",
        details: { slug: "gamma", dbName: "ws_gamma" },
      },
    });

    const result = await creator.createWorkspace({ name: "Gamma", slug: "gamma" });

    expect(result).toEqual({
      ok: false,
      reason: "scope-update-failed",
      slug: "gamma",
      dbName: "ws_gamma",
    });
    expect(calls.storeToken).toHaveLength(0);
    expect(calls.enter).toHaveLength(0);
    expect(calls.navigate).toHaveLength(0);
  });

  test("storeAccessToken 返回 null（token 响应无效）：返回 refresh-failed，不 enter / navigate", async () => {
    const { creator, calls } = setup({ storeAccessToken: () => null });

    const result = await creator.createWorkspace({ name: "Gamma", slug: "gamma" });

    expect(result).toEqual({ ok: false, reason: "refresh-failed" });
    expect(calls.enter).toHaveLength(0);
    expect(calls.navigate).toHaveLength(0);
  });

  test("403 forbidden：返回 forbidden，不 store token / enter", async () => {
    const { creator, calls } = setup({
      outcome: { kind: "error", status: 403, code: "workspace-create-forbidden" },
    });

    const result = await creator.createWorkspace({ name: "Gamma", slug: "gamma" });

    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(calls.storeToken).toHaveLength(0);
    expect(calls.enter).toHaveLength(0);
  });

  test("401 会话过期：返回 refresh-failed，不 store token / enter", async () => {
    const { creator, calls } = setup({
      outcome: { kind: "error", status: 401, code: "oidc-expired" },
    });

    const result = await creator.createWorkspace({ name: "Gamma", slug: "gamma" });

    expect(result).toEqual({ ok: false, reason: "refresh-failed" });
    expect(calls.storeToken).toHaveLength(0);
    expect(calls.enter).toHaveLength(0);
  });

  test("其它错误（500）：返回 error 并带 message，不 store token / enter", async () => {
    const { creator, calls } = setup({
      outcome: { kind: "error", status: 500, code: "internal" },
    });

    const result = await creator.createWorkspace({ name: "Gamma", slug: "gamma" });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "error", message: "internal" });
    expect(calls.storeToken).toHaveLength(0);
    expect(calls.enter).toHaveLength(0);
  });
});
