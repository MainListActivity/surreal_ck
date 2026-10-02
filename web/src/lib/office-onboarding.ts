import type { SurrealConn } from "./surreal";
import { recordIdString, toRecordId } from "./record-id";

/**
 * VO06 onboarding 编排模块：把「保存目标 → 导入/skip → 幂等 bootstrap →
 * 等待进度/首份报告 → 继续开岗分析师并派发分析任务」收敛成纯函数 + 窄 IO。
 *
 * 状态完全以 db 为真源（office_meta.import_state / office_task /
 * employee_trigger / office_report），浏览器不存本地步骤标记——刷新、
 * 断线重连、切换 workspace 后重进同一 db，读到的就是同一进度。
 *
 * 写入边界：goal/primary_contact/import_state/office_task 全部走 admin
 * 浏览器直连（schema PERMISSIONS 已约束 assigner = fn::current_user()、
 * primary_contact 只接受 human kind）；bootstrap / dispatch 两个动作走
 * 既有窄端点，浏览器不碰 employee_trigger。
 */

// ── 类型 ──────────────────────────────────────────────────────────────────

export type ImportState = "imported" | "skipped" | "failed";

export type OnboardingMeta = {
  goal: string;
  state: string;
  primaryContactId: string | null;
  importState: ImportState | null;
};

/** onboarding 阶段：由 db 行推导，不是可写状态。 */
export type OnboardingPhase = "meta" | "import" | "ready" | "active";

export type OnboardingState = {
  meta: OnboardingMeta | null;
  phase: OnboardingPhase;
  /** bootstrap 已生成的初始任务（存在即视为已开岗收敛过）。 */
  initialTaskId: string | null;
  /** 首份报告行 id；出现即首跑闭环完成。 */
  firstReportId: string | null;
};

export type ApiLike = {
  workspaces: {
    ":slug": {
      office: {
        bootstrap: {
          $post(input: { param: { slug: string } }): Promise<{
            ok: boolean;
            status: number;
            json(): Promise<unknown>;
          }>;
        };
        tasks: {
          ":taskId": {
            dispatch: {
              $post(input: { param: { slug: string; taskId: string } }): Promise<{
                ok: boolean;
                status: number;
                json(): Promise<unknown>;
              }>;
            };
          };
        };
      };
      employees: {
        $post(input: {
          param: { slug: string };
          json: { requestKey: string; displayName: string; roleKey?: string };
        }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
      };
    };
  };
};

export type BootstrapOutcome =
  | { ok: true; employeeId: string; taskId: string | null }
  | { ok: false; message: string; missing?: string[] };

/** 卡顿时给用户看的根因分类（AC：区分模型/数据库/预算/员工状态）。 */
export type StallCause = "model" | "database" | "budget" | "employee" | "unknown";

export type StallDiagnosis = {
  cause: StallCause;
  /** 展示给用户的具体证据（触发错误/员工状态）。 */
  detail: string;
};

// ── 查询与阶段推导 ─────────────────────────────────────────────────────────

type MetaRow = Record<string, unknown>;
type IdRow = { id: unknown };

function asMeta(row: MetaRow | undefined): OnboardingMeta | null {
  if (!row) return null;
  const importState = row.import_state;
  return {
    goal: typeof row.goal === "string" ? row.goal : "",
    state: typeof row.state === "string" ? row.state : "pending",
    primaryContactId:
      recordIdString(row.primary_contact),
    importState:
      importState === "imported" || importState === "skipped" || importState === "failed"
        ? importState
        : null,
  };
}

export function derivePhase(
  meta: OnboardingMeta | null,
  initialTaskId: string | null,
): OnboardingPhase {
  if (meta?.state === "active" || initialTaskId) return "active";
  if (!meta || !meta.goal.trim() || !meta.primaryContactId) return "meta";
  if (meta.importState !== "imported" && meta.importState !== "skipped") return "import";
  return "ready";
}

/** 读 db 真源推导当前 onboarding 状态（刷新/重连后调它恢复）。 */
export async function loadOnboardingState(conn: SurrealConn): Promise<OnboardingState> {
  const metaRows = await conn.query<MetaRow>(
    "SELECT goal, state, primary_contact, import_state FROM office_meta:office;",
  );
  const meta = asMeta(metaRows[0]);
  const taskRows = await conn.query<IdRow>(
    "SELECT id FROM office_task:pm_initial;",
  );
  const initialTaskId =
    recordIdString(taskRows[0]?.id);
  const reportRows = await conn.query<IdRow>(
    "SELECT id FROM office_report LIMIT 1;",
  );
  const firstReportId =
    recordIdString(reportRows[0]?.id);
  return {
    meta,
    phase: derivePhase(meta, initialTaskId),
    initialTaskId,
    firstReportId,
  };
}

// ── 元数据写入（admin 直连） ────────────────────────────────────────────────

/**
 * 保存目标并把「第一位合法 primary_contact」登记为当前用户。
 * `primary_contact ?? fn::current_user()`：已存在的联系人在 UPSERT 下保留
 * （RHS 字段引用先评估旧值），刷新/重试/换管理员都不会静默换人。
 * state 只在 pending → onboarding 前进一步；active / onboarding 不回头。
 */
export async function saveOnboardingGoal(conn: SurrealConn, goal: string): Promise<void> {
  await conn.query(
    `UPSERT office_meta:office SET
       goal = $goal,
       primary_contact = primary_contact ?? fn::current_user(),
       state = IF state = "pending" THEN "onboarding" ELSE state END,
       updated_at = time::now();`,
    { goal: goal.trim() },
  );
}

/**
 * 导入决议：只能从「未决议 / 失败」推进到 imported / skipped / failed；
 * 已决议的行拒绝覆盖（WHERE 守卫）——skip 之后再点导入不会把 imported
 * 静默改回，反之亦然，保证 bootstrap 门禁读到的决议稳定。
 */
export async function resolveImport(
  conn: SurrealConn,
  state: ImportState,
): Promise<void> {
  await conn.query(
    `UPDATE office_meta:office SET
       import_state = $state,
       updated_at = time::now()
     WHERE import_state IS NONE OR import_state = "failed" OR import_state = $state;`,
    { state },
  );
}

// ── bootstrap / 投递 / 开岗（窄端点） ───────────────────────────────────────

function messageFrom(body: unknown, status: number): string {
  const raw =
    body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : "";
  return raw || `请求失败 (${status})`;
}

function missingFrom(body: unknown): string[] | undefined {
  const message =
    body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : "";
  const match = message.match(/缺少 (.+)$/);
  return match ? match[1].split(/,\s*/) : undefined;
}

export async function submitBootstrap(api: ApiLike, slug: string): Promise<BootstrapOutcome> {
  const response = await api.workspaces[":slug"].office.bootstrap.$post({
    param: { slug },
  });
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as {
      employeeId?: unknown;
      taskId?: unknown;
    } | null;
    return {
      ok: true,
      employeeId: typeof body?.employeeId === "string" ? body.employeeId : "",
      taskId: typeof body?.taskId === "string" ? body.taskId : null,
    };
  }
  const body = await response.json().catch(() => null);
  return {
    ok: false,
    message: messageFrom(body, response.status),
    missing: missingFrom(body),
  };
}

export async function dispatchTask(
  api: ApiLike,
  slug: string,
  taskId: string,
): Promise<{ ok: boolean; message?: string }> {
  const response = await api.workspaces[":slug"].office.tasks[":taskId"].dispatch.$post({
    param: { slug, taskId },
  });
  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => null);
  return { ok: false, message: messageFrom(body, response.status) };
}

/** office_role 种子只含 project-manager / data-analyst；onboarding 不暴露其他岗位。 */
export const ONBOARDING_ROLES = ["project-manager", "data-analyst"] as const;
export type OnboardingRole = (typeof ONBOARDING_ROLES)[number];

/** 与 PM 委派路径共用稳定 requestKey → 重复开岗收敛到同一员工行。 */
export function officeRoleRequestKey(role: OnboardingRole): string {
  return `office-role:${role}`;
}

export async function provisionOfficeEmployee(
  api: ApiLike,
  slug: string,
  role: OnboardingRole,
  displayName: string,
): Promise<{ ok: true; employeeId: string } | { ok: false; message: string }> {
  const response = await api.workspaces[":slug"].employees.$post({
    param: { slug },
    json: { requestKey: officeRoleRequestKey(role), displayName, roleKey: role },
  });
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as {
      employee?: { id?: unknown };
    } | null;
    const id = body?.employee?.id == null ? "" : String(body.employee.id);
    return id ? { ok: true, employeeId: id } : { ok: false, message: "开岗响应缺少员工 id" };
  }
  const body = await response.json().catch(() => null);
  return { ok: false, message: messageFrom(body, response.status) };
}

// ── 分析任务创建（浏览器直连 + 幂等 id） ────────────────────────────────────

/** 与服务端 OFFICE_INITIAL_TASK_ID（office-domain.ts）对齐的确定性 id。 */
export const OFFICE_INITIAL_TASK_ID = "office_task:pm_initial";

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 管理员派发任务给员工的确定性 id：同一 (assignee, goal, brief) 永远映射到
 * 同一 record id；重复提交/刷新重建走到 INSERT ... ON DUPLICATE KEY UPDATE
 * 幂等收敛，brief 是 READONLY 故冲突分支只碰 updated_at。
 */
export function onboardingTaskId(
  assigneeId: string,
  goal: string,
  brief: Record<string, unknown>,
): string {
  return `office_task:utask_${fnv1a(`${assigneeId}|${goal}|${JSON.stringify(brief)}`)}`;
}

export async function createAssignedTask(
  conn: SurrealConn,
  input: {
    assigneeId: string;
    goal: string;
    brief?: Record<string, unknown>;
    parentId?: string | null;
  },
): Promise<string> {
  const brief = input.brief ?? {};
  const id = onboardingTaskId(input.assigneeId, input.goal, brief);
  const [rows] = await conn.query<IdRow[]>(
    `INSERT INTO office_task [{
       id: $id,
       goal: $goal,
       assigner: fn::current_user(),
       assignee: $assignee,
       brief: $brief,
       depth: $depth,
       parent: $parent
     }] ON DUPLICATE KEY UPDATE updated_at = time::now()
     RETURN id;`,
    {
      id: toRecordId(id),
      goal: input.goal,
      assignee: toRecordId(input.assigneeId),
      brief,
      depth: input.parentId ? 1 : 0,
      parent: input.parentId ? toRecordId(input.parentId) : null,
    },
  );
  const created = Array.isArray(rows) ? rows[0] : rows;
  return recordIdString(created?.id) ?? id;
}

// ── 停滞诊断 ────────────────────────────────────────────────────────────────

type TriggerRow = { status?: unknown; error_message?: unknown; attempts?: unknown };
type EmployeeRow = { virtual_profile?: { status?: unknown } };

const STALL_PATTERNS: Array<[StallCause, RegExp]> = [
  // 顺序即优先级：错误串可能同时含 "model ... timed out"，先归模型再归数据库。
  ["budget", /budget|quota|预算|额度/i],
  ["employee", /signin|session|credential|inactive|paused|retired|未激活/i],
  ["model", /model|provider|openai|anthropic|llm|completion/i],
  ["database", /socket|network|connect|database|timed? ?out|超时/i],
];

/**
 * 由 employee_trigger + assignee 员工行推导停滞根因。
 * 触发行不存在/仍在跑 → 员工状态定因；trigger 失败 → 错误文本归类。
 */
export function diagnoseStall(input: {
  trigger?: { status: string; errorMessage: string | null } | null;
  employeeStatus?: string | null;
  elapsedMs: number;
}): StallDiagnosis | null {
  const { trigger, employeeStatus, elapsedMs } = input;
  if (trigger?.status === "completed") return null;
  if (employeeStatus && employeeStatus !== "active" && employeeStatus !== "provisioning") {
    return { cause: "employee", detail: `员工状态 ${employeeStatus}` };
  }
  const error = trigger?.errorMessage ?? "";
  if (!error && trigger && trigger.status !== "failed") {
    // 触发在排队/运行中：排程层问题归"员工"（runtime 未拾取），其余不足以定因。
    return elapsedMs > 0 ? { cause: "employee", detail: `触发仍在 ${trigger.status}` } : null;
  }
  if (!error) return null;
  for (const [cause, pattern] of STALL_PATTERNS) {
    if (pattern.test(error)) return { cause, detail: error };
  }
  return { cause: "unknown", detail: error };
}

/** 读 bootstrap 触发与员工行供 diagnoseStall 使用（admin 可读 employee_trigger）。 */
export async function loadBootstrapTrigger(conn: SurrealConn): Promise<{
  status: string;
  errorMessage: string | null;
} | null> {
  const rows = await conn.query<TriggerRow>(
    `SELECT status, error_message FROM employee_trigger
     WHERE idempotency_key = "office-bootstrap" LIMIT 1;`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: typeof row.status === "string" ? row.status : "unknown",
    errorMessage: typeof row.error_message === "string" ? row.error_message : null,
  };
}

export async function loadEmployeeStatus(
  conn: SurrealConn,
  employeeId: string,
): Promise<string | null> {
  const rows = await conn.query<EmployeeRow>(
    "SELECT virtual_profile.status AS vs FROM user WHERE id = $id;",
    { id: toRecordId(employeeId) },
  );
  const status = rows[0]?.virtual_profile?.status;
  return typeof status === "string" ? status : null;
}

/** 按岗位查第一位虚拟员工的状态（bootstrap 的 PM 就是 role_key=project-manager）。 */
export async function loadEmployeeStatusByRole(
  conn: SurrealConn,
  roleKey: OnboardingRole,
): Promise<string | null> {
  const rows = await conn.query<{ vs?: unknown }>(
    `SELECT virtual_profile.status AS vs FROM user
     WHERE kind = "virtual" AND virtual_profile.role_key = $role LIMIT 1;`,
    { role: roleKey },
  );
  const status = rows[0]?.vs;
  return typeof status === "string" ? status : null;
}

export const STALL_CAUSE_LABELS: Record<StallCause, string> = {
  model: "模型",
  database: "数据库",
  budget: "预算/限额",
  employee: "员工状态",
  unknown: "未知原因",
};
