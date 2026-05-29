import { describe, expect, test } from "bun:test";
import {
  canCreateWorkspace,
  createWorkspaceSwitcher,
  currentDbFromToken,
  type SwitchDeps,
  type WorkspaceListItem,
} from "./switch-workspace";

/** 拼一个最小可解析的 JWT：仅 payload 段有意义。 */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

const workspaces: WorkspaceListItem[] = [
  { slug: "alpha", name: "Alpha", dbName: "ws_alpha", role: "admin", lastSelectedAt: null },
  { slug: "beta", name: "Beta", dbName: "ws_beta", role: "participant", lastSelectedAt: null },
];

type SwitchResponse = { status: number; body: unknown };

function setup(overrides: Partial<SwitchDeps> & { switchResponses?: SwitchResponse[] } = {}) {
  const calls = {
    switch: [] as Array<{ workspaceSlug: string }>,
    refresh: 0,
    enter: [] as Array<{ rawToken: string; dbName: string; role?: string; slug?: string; name?: string }>,
    navigate: [] as string[],
  };

  const switchResponses = overrides.switchResponses ?? [{ status: 200, body: { ok: true, refreshRequired: true } }];
  let switchIdx = 0;

  let token = overrides.getToken?.() ?? jwt({ "https://surrealdb.com/db": "ws_alpha" });

  const deps: SwitchDeps = {
    listWorkspaces:
      overrides.listWorkspaces ?? (async () => workspaces),
    requestSwitch:
      overrides.requestSwitch ??
      (async (workspaceSlug) => {
        calls.switch.push({ workspaceSlug });
        const res = switchResponses[Math.min(switchIdx++, switchResponses.length - 1)];
        if (res.status === 200) return { ok: true, refreshRequired: true };
        const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }),
    refresh:
      overrides.refresh ??
      (async () => {
        calls.refresh += 1;
        token = jwt({ "https://surrealdb.com/db": "ws_beta" });
        return token;
      }),
    enterWorkspace:
      overrides.enterWorkspace ??
      (async (input) => {
        calls.enter.push(input);
      }),
    getToken: overrides.getToken ?? (() => token),
    navigate: overrides.navigate ?? ((url) => calls.navigate.push(url)),
  };

  return { switcher: createWorkspaceSwitcher(deps), calls };
}

describe("currentDbFromToken", () => {
  test("从 token 的 surrealdb.com/db claim 取当前 db", () => {
    expect(currentDbFromToken(jwt({ "https://surrealdb.com/db": "ws_alpha" }))).toBe("ws_alpha");
  });

  test("无 token / 无 claim 时返回 null", () => {
    expect(currentDbFromToken(null)).toBeNull();
    expect(currentDbFromToken(jwt({ sub: "u" }))).toBeNull();
    expect(currentDbFromToken("not-a-jwt")).toBeNull();
  });
});

describe("canCreateWorkspace", () => {
  test("can_create_workspace=true 可建", () => {
    expect(canCreateWorkspace(jwt({ can_create_workspace: true }))).toBe(true);
  });

  test("命名空间 claim 可建", () => {
    expect(canCreateWorkspace(jwt({ "https://surreal-ck.com/can_create_workspace": true }))).toBe(true);
  });

  test("scope 含 workspace:create 可建", () => {
    expect(canCreateWorkspace(jwt({ scope: "openid workspace:create email" }))).toBe(true);
  });

  test("无任何信号不可建", () => {
    expect(canCreateWorkspace(jwt({ scope: "openid email" }))).toBe(false);
    expect(canCreateWorkspace(null)).toBe(false);
  });
});

describe("loadWorkspaces", () => {
  test("返回列表，并标记 token 当前 db 对应项为 current", async () => {
    const { switcher } = setup();
    const result = await switcher.loadWorkspaces();

    expect(result.workspaces).toEqual(workspaces);
    expect(result.currentDbName).toBe("ws_alpha");
    expect(result.canCreate).toBe(false);
  });
});

describe("switchWorkspace", () => {
  test("成功路径：POST switch → refresh → enterWorkspace 新 db → URL 更新 /w/<slug>", async () => {
    const { switcher, calls } = setup();

    const result = await switcher.switchWorkspace("beta");

    expect(result.ok).toBe(true);
    expect(calls.switch).toEqual([{ workspaceSlug: "beta" }]);
    expect(calls.refresh).toBe(1);
    expect(calls.enter).toHaveLength(1);
    // refresh 后新 token 的 db 是 ws_beta，用新 token 连新库
    expect(calls.enter[0]).toMatchObject({
      dbName: "ws_beta",
      role: "participant",
      slug: "beta",
      name: "Beta",
    });
    expect(calls.navigate).toEqual(["/w/beta"]);
  });

  test("已在目标 workspace 时短路：不调 switch / refresh / enter", async () => {
    const { switcher, calls } = setup();
    // token 当前 db 已是 ws_alpha
    const result = await switcher.switchWorkspace("alpha");

    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
    expect(calls.switch).toHaveLength(0);
    expect(calls.refresh).toBe(0);
    expect(calls.enter).toHaveLength(0);
  });

  test("后端 403：不 refresh、不 enter，旧连接保持，结果含 forbidden", async () => {
    const { switcher, calls } = setup({
      switchResponses: [{ status: 403, body: { error: "workspace-forbidden" } }],
    });

    const result = await switcher.switchWorkspace("beta");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("forbidden");
    expect(calls.switch).toEqual([{ workspaceSlug: "beta" }]);
    expect(calls.refresh).toBe(0);
    expect(calls.enter).toHaveLength(0);
    expect(calls.navigate).toHaveLength(0);
  });

  test("未知 slug（不在列表）：直接返回 forbidden，不打后端", async () => {
    const { switcher, calls } = setup();

    const result = await switcher.switchWorkspace("ghost");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("forbidden");
    expect(calls.switch).toHaveLength(0);
  });

  test("refresh 返回 null（会话失效）：不 enter，结果含 refresh-failed", async () => {
    const { switcher, calls } = setup({
      refresh: async () => null,
    });

    const result = await switcher.switchWorkspace("beta");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("refresh-failed");
    expect(calls.enter).toHaveLength(0);
  });
});
