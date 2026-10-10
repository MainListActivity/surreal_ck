import { describe, expect, test } from "bun:test";
import {
  createInviteMemberController,
  initialInviteMemberState,
  type InviteMemberState,
} from "./invite-member";
import type { WorkspaceMember } from "./members-data";
import type { SurrealConn } from "./surreal";

const conn = { status: "connected" } as unknown as SurrealConn;

function member(partial: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    id: "user:m1",
    displayName: null,
    email: "m1@example.com",
    isAdmin: false,
    pending: true,
    ...partial,
  };
}

function withEmail(partial: Partial<InviteMemberState> = {}): InviteMemberState {
  return {
    ...initialInviteMemberState(),
    email: "new@example.com",
    displayName: "新成员",
    role: "participant",
    ...partial,
  };
}

describe("invite-member controller — 管理员邀请流程", () => {
  test("提交成功后调用 POST members endpoint 并刷新成员入列", async () => {
    let captured: { slug: string; input: { email: string; displayName?: string; isAdmin: boolean } } | null = null;
    const controller = createInviteMemberController({
      addMember: async (slug, input) => {
        captured = { slug, input };
        return { ok: true };
      },
      loadMembers: async () => [
        member({ id: "user:admin", email: "admin@example.com", isAdmin: true, pending: false }),
        member({ id: "user:new", email: "new@example.com", displayName: "新成员" }),
      ],
    });

    const next = await controller.submit(withEmail(), "acme", conn);

    expect(captured).toEqual({
      slug: "acme",
      input: { email: "new@example.com", displayName: "新成员", isAdmin: false },
    });
    expect(next.writing).toBe(false);
    expect(next.error).toBeNull();
    expect(next.notice).toContain("new@example.com");
    // 表单复位，成员列表已刷新且包含新成员（待加入）
    expect(next.email).toBe("");
    expect(next.displayName).toBe("");
    expect(next.role).toBe("participant");
    expect(next.members.map((m) => m.email)).toContain("new@example.com");
    expect(next.members.find((m) => m.email === "new@example.com")?.pending).toBe(true);
  });

  test("角色选管理员时传 isAdmin: true", async () => {
    let capturedIsAdmin: boolean | null = null;
    const controller = createInviteMemberController({
      addMember: async (_slug, input) => {
        capturedIsAdmin = input.isAdmin;
        return { ok: true };
      },
      loadMembers: async () => [],
    });

    await controller.submit(withEmail({ role: "admin" }), "acme", conn);

    expect(capturedIsAdmin).toBe(true);
  });

  test("非管理员提交被后端 403 拒绝时展示错误消息", async () => {
    const controller = createInviteMemberController({
      addMember: async () => ({
        ok: false,
        message: "Only a workspace admin can manage members",
      }),
      loadMembers: async () => {
        throw new Error("loadMembers should not be called after a failed submit");
      },
    });

    const next = await controller.submit(withEmail(), "acme", conn);

    expect(next.writing).toBe(false);
    expect(next.error).toBe("Only a workspace admin can manage members");
    expect(next.notice).toBeNull();
    // 输入保留供重试，成员列表保持原样
    expect(next.email).toBe("new@example.com");
    expect(next.members).toEqual([]);
  });

  test("邮箱为空时不发起任何请求", async () => {
    let called = false;
    const controller = createInviteMemberController({
      addMember: async () => {
        called = true;
        return { ok: true };
      },
    });

    const next = await controller.submit(withEmail({ email: "   " }), "acme", conn);

    expect(called).toBe(false);
    expect(next.writing).toBe(false);
  });

  test("成员列表加载失败时展示 membersError 而不阻塞表单", async () => {
    const controller = createInviteMemberController({
      loadMembers: async () => {
        throw new Error("permission denied");
      },
    });

    const next = await controller.reloadMembers(initialInviteMemberState(), conn);

    expect(next.membersLoading).toBe(false);
    expect(next.membersError).toBe("permission denied");
  });
});
