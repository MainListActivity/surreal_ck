import { describe, expect, test } from "bun:test";
import {
  renameWorkspace,
  type WorkspaceMetaEndpointClient,
} from "./workspace-meta-data";

function fakeEndpoint(over: Partial<WorkspaceMetaEndpointClient> = {}): WorkspaceMetaEndpointClient {
  return {
    rename: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    ...over,
  };
}

describe("renameWorkspace — 工作区显示名写入走 Workspace Scope endpoint", () => {
  test("成功时 trim 名称、调用 PATCH /api/workspaces/:slug，并返回规范化名称", async () => {
    let captured: { slug: string; name: string } | null = null;
    const endpoint = fakeEndpoint({
      rename: async (slug, name) => {
        captured = { slug, name };
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });

    const result = await renameWorkspace("acme", "  Acme Legal  ", endpoint);

    expect(result).toEqual({ ok: true, name: "Acme Legal" });
    expect(captured).toEqual({ slug: "acme", name: "Acme Legal" });
  });

  test("后端拒绝时归一为 ok:false 和可展示错误消息", async () => {
    const endpoint = fakeEndpoint({
      rename: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: { code: "workspace-rename-forbidden", message: "Only admins" } }),
      }),
    });

    const result = await renameWorkspace("acme", "Acme Legal", endpoint);

    expect(result).toEqual({ ok: false, message: "Only admins" });
  });

  test("空名在前端数据层直接拒绝，不触碰 endpoint", async () => {
    let called = false;
    const endpoint = fakeEndpoint({
      rename: async () => {
        called = true;
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });

    const result = await renameWorkspace("acme", "   ", endpoint);

    expect(result).toEqual({ ok: false, message: "工作区名称不能为空" });
    expect(called).toBe(false);
  });
});
