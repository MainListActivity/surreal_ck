import {
  addMember as addMemberDefault,
  loadMembers as loadMembersDefault,
  type MemberWriteResult,
  type WorkspaceMember,
} from "./members-data";
import type { SurrealConn } from "./surreal";

/**
 * 「邀请协作者」弹窗的 controller：复用 Workspace Scope 的
 * `POST /api/workspaces/:slug/members`（admin 门控，member-admin-forbidden → 403）。
 * 前端不预判调用者角色——权限由后端权威执行，非管理员提交拿到的 403
 * 直接以错误消息展示。成员列表走 workspace db 直连读（user 表
 * `FOR select WHERE $auth != NONE`，participant 可读）。
 */
export type InviteMemberRole = "participant" | "admin";

export type InviteMemberState = {
  email: string;
  displayName: string;
  role: InviteMemberRole;
  writing: boolean;
  error: string | null;
  notice: string | null;
  members: WorkspaceMember[];
  membersLoading: boolean;
  membersError: string | null;
};

export type InviteMemberDeps = {
  addMember?: (
    slug: string,
    input: { email: string; displayName?: string; isAdmin: boolean },
  ) => Promise<MemberWriteResult>;
  loadMembers?: (conn: SurrealConn) => Promise<WorkspaceMember[]>;
};

export function initialInviteMemberState(): InviteMemberState {
  return {
    email: "",
    displayName: "",
    role: "participant",
    writing: false,
    error: null,
    notice: null,
    members: [],
    membersLoading: false,
    membersError: null,
  };
}

export function createInviteMemberController(deps: InviteMemberDeps = {}) {
  const addMember = deps.addMember ?? addMemberDefault;
  const loadMembers = deps.loadMembers ?? loadMembersDefault;

  async function reloadMembers(
    state: InviteMemberState,
    conn: SurrealConn,
  ): Promise<InviteMemberState> {
    const loading = { ...state, membersLoading: true, membersError: null };
    try {
      const members = await loadMembers(conn);
      return { ...loading, members, membersLoading: false };
    } catch (cause) {
      return {
        ...loading,
        membersLoading: false,
        membersError: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  return {
    reloadMembers,

    async submit(
      state: InviteMemberState,
      slug: string,
      conn: SurrealConn,
    ): Promise<InviteMemberState> {
      const email = state.email.trim();
      if (state.writing || !slug || email.length === 0) return state;

      const submitting: InviteMemberState = {
        ...state,
        email,
        writing: true,
        error: null,
        notice: null,
      };

      const result = await addMember(slug, {
        email,
        displayName: state.displayName,
        isAdmin: state.role === "admin",
      });

      if (!result.ok) {
        return { ...submitting, writing: false, error: result.message };
      }

      const invited: InviteMemberState = {
        ...submitting,
        writing: false,
        email: "",
        displayName: "",
        role: "participant",
        notice: `已邀请 ${email}；对方首次登录后自动加入工作区。`,
      };
      return reloadMembers(invited, conn);
    },
  };
}
