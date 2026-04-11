import { useEffect, useReducer, useState } from 'react';
import type { Surreal } from 'surrealdb';

export type MemberRole = 'admin' | 'editor' | 'viewer';

export interface WorkspaceMember {
  id: string;
  email: string;
  role: MemberRole;
  invited_at: string;
}

interface State {
  items: WorkspaceMember[];
  isLoading: boolean;
  error: string | null;
  isInviting: boolean;
  inviteError: string | null;
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; items: WorkspaceMember[] }
  | { type: 'load-err'; error: string }
  | { type: 'invite-start' }
  | { type: 'invite-ok'; item: WorkspaceMember }
  | { type: 'invite-err'; error: string }
  | { type: 'remove-ok'; id: string }
  | { type: 'role-ok'; id: string; role: MemberRole }
  | { type: 'clear-invite-error' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoading: true, error: null };
    case 'load-ok':
      return { ...state, isLoading: false, items: action.items };
    case 'load-err':
      return { ...state, isLoading: false, error: action.error };
    case 'invite-start':
      return { ...state, isInviting: true, inviteError: null };
    case 'invite-ok':
      return { ...state, isInviting: false, items: [...state.items, action.item] };
    case 'invite-err':
      return { ...state, isInviting: false, inviteError: action.error };
    case 'remove-ok':
      return { ...state, items: state.items.filter((m) => m.id !== action.id) };
    case 'role-ok':
      return {
        ...state,
        items: state.items.map((m) => (m.id === action.id ? { ...m, role: action.role } : m)),
      };
    case 'clear-invite-error':
      return { ...state, inviteError: null };
    default:
      return state;
  }
}

const ROLE_LABELS: Record<MemberRole, string> = {
  admin: '管理员',
  editor: '编辑者',
  viewer: '查看者',
};

export interface WorkspaceMembersPanelProps {
  db: Surreal;
  workspaceId: string;
}

export function WorkspaceMembersPanel({ db, workspaceId }: WorkspaceMembersPanelProps) {
  const [state, dispatch] = useReducer(reducer, {
    items: [], isLoading: false, error: null, isInviting: false, inviteError: null,
  });
  const [showForm, setShowForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<MemberRole>('editor');

  useEffect(() => {
    void loadMembers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function loadMembers() {
    dispatch({ type: 'load-start' });
    try {
      const [rows] = await db.query<[WorkspaceMember[]]>(
        `SELECT
           out.id AS id,
           out.email AS email,
           out.role AS role,
           out.invited_at AS invited_at
         FROM workspace_has_member
         WHERE in = $ws
         ORDER BY out.invited_at DESC`,
        { ws: workspaceId },
      );
      dispatch({ type: 'load-ok', items: rows ?? [] });
    } catch (err) {
      dispatch({ type: 'load-err', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleInvite() {
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;

    // Check for duplicate before sending to DB.
    const alreadyMember = state.items.some((m) => m.email === email);
    if (alreadyMember) {
      dispatch({ type: 'invite-err', error: 'Already a member. Update their role in the list below.' });
      return;
    }

    dispatch({ type: 'invite-start' });
    try {
      const [created] = await db.query<[WorkspaceMember[]]>(
        `LET $member = (INSERT INTO workspace_member {
           workspace: $ws,
           email: $email,
           role: $role
         } RETURN AFTER)[0];
         RELATE $ws->workspace_has_member->$member;
         RETURN $member;`,
        { ws: workspaceId, email, role: inviteRole },
      );
      const item = created?.[0];
      if (!item) throw new Error('workspace_member record not returned');

      dispatch({ type: 'invite-ok', item });
      setInviteEmail('');
      setShowForm(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Detect unique constraint violation (duplicate email in DB race).
      const isDuplicate = message.includes('already exists') || message.includes('unique');
      dispatch({
        type: 'invite-err',
        error: isDuplicate ? 'Already a member with this email.' : message,
      });
    }
  }

  async function handleRoleChange(member: WorkspaceMember, role: MemberRole) {
    try {
      await db.query(
        'UPDATE $id SET role = $role',
        { id: member.id, role },
      );
      dispatch({ type: 'role-ok', id: member.id, role });
    } catch {
      // non-fatal — UI stays optimistic; reload on next mount
    }
  }

  async function handleRemove(member: WorkspaceMember) {
    try {
      await db.query(
        'DELETE workspace_has_member WHERE in = $ws AND out = $id; DELETE $id',
        { ws: workspaceId, id: member.id },
      );
      dispatch({ type: 'remove-ok', id: member.id });
    } catch {
      // non-fatal
    }
  }

  return (
    <section aria-label="工作区成员">
      <div className="admin-section-header">
        <h3>工作区成员</h3>
        <button
          className="secondary-button"
          type="button"
          onClick={() => { setShowForm(true); dispatch({ type: 'clear-invite-error' }); }}
        >
          邀请
        </button>
      </div>

      {showForm && (
        <form className="admin-inline-form" onSubmit={(e) => { e.preventDefault(); void handleInvite(); }}>
          <label className="admin-form-label" htmlFor="invite-email">
            邮箱地址
            <input
              id="invite-email"
              className="admin-form-input"
              type="email"
              placeholder="user@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              disabled={state.isInviting}
              autoFocus
            />
          </label>
          <label className="admin-form-label" htmlFor="invite-role">
            角色
            <select
              id="invite-role"
              className="admin-form-input"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as MemberRole)}
              disabled={state.isInviting}
            >
              {(Object.keys(ROLE_LABELS) as MemberRole[]).map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </label>
          {state.inviteError && (
            <p className="admin-form-error" role="alert">{state.inviteError}</p>
          )}
          <div className="admin-form-actions">
            <button className="primary-button" type="submit" disabled={state.isInviting || !inviteEmail.trim()}>
              {state.isInviting ? '邀请中…' : '发送邀请'}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => { setShowForm(false); setInviteEmail(''); }}
            >
              取消
            </button>
          </div>
        </form>
      )}

      {state.isLoading && <p className="sidebar-copy">加载中…</p>}
      {state.error && <p className="sidebar-copy" style={{ color: 'var(--color-error)' }}>{state.error}</p>}
      {!state.isLoading && state.items.length === 0 && <p className="sidebar-copy">暂无成员。</p>}

      <ul className="admin-list" role="list">
        {state.items.map((member) => (
          <li key={member.id} className="admin-list-item">
            <div>
              <strong>{member.email}</strong>
            </div>
            <div className="admin-list-item__actions">
              <select
                className="admin-form-input admin-form-input--sm"
                value={member.role}
                onChange={(e) => void handleRoleChange(member, e.target.value as MemberRole)}
                aria-label={`${member.email} 的角色`}
              >
                {(Object.keys(ROLE_LABELS) as MemberRole[]).map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <button
                className="ghost-button"
                type="button"
                aria-label={`移除 ${member.email}`}
                onClick={() => void handleRemove(member)}
              >
                移除
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
