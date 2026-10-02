import { createHash } from "node:crypto";
import { StringRecordId } from "surrealdb";
import { z } from "zod";
import { normalizeOfficeDdl, officeDdlFingerprint, DDL_TERMINAL } from "@surreal-ck/shared/office-ddl";
import type { TriggerHandlerContext, TriggerSession } from "./employee-trigger-runtime";
import { createEmployeeLifecycle } from "./employee-lifecycle";
import { getRootDatabaseSession } from "../../src/db/root-connection";
import { getEmployeeRuntime } from "./employee-service";
import {
  createOfficeRequest, createOfficeTaskOnce, deliverOfficeReport, getOfficeTask,
  postOfficeMessage, readOfficeMeta, requireOfficeMeta, setOfficeTaskStatus,
  type OfficeTaskRow, type OfficeRequestRow,
} from "./office-domain";

export const OFFICE_ANALYST_REQUEST_KEY = "office-role:data-analyst";
export type AnalystProvisioner = (ctx: TriggerHandlerContext) => Promise<string>;

/** PM 的 user 写走它自己的员工会话；root 仅在既有 lifecycle 内维护凭证。 */
export const provisionOfficeAnalyst: AnalystProvisioner = async (ctx) => {
  const [[manager]] = await ctx.session.query<[{ id?: unknown; role?: string; status?: string }[]]>(
    "SELECT id, virtual_profile.role_key AS role, virtual_profile.status AS status FROM fn::current_user();",
  );
  if (String(manager?.id) !== ctx.trigger.employeeId || manager?.role !== "project-manager" || manager.status !== "active") {
    throw new Error("analyst-provision: active project manager required");
  }
  const lifecycle = createEmployeeLifecycle({
    resolveWorkspace: async () => ({ dbName: ctx.trigger.database }),
    callerSession: async () => ctx.session,
    rootSession: getRootDatabaseSession,
    runtime: getEmployeeRuntime(),
  });
  const outcome = await lifecycle.provision({
    slug: "office-internal", callerToken: "", requestKey: OFFICE_ANALYST_REQUEST_KEY,
    roleKey: "data-analyst", displayName: "数据分析师", supervisor: ctx.trigger.employeeId,
  });
  if (outcome.kind !== "ok" || outcome.employee.status !== "active") throw new Error(`analyst-provision:${outcome.kind}`);
  return outcome.employee.id;
};

export async function delegateToAnalyst(ctx: TriggerHandlerContext, parent: OfficeTaskRow,
  provision: AnalystProvisioner = provisionOfficeAnalyst): Promise<string> {
  const analyst = await provision(ctx);
  const child = await createOfficeTaskOnce(ctx.session, `office_task:analysis_${parent.id.replace(/\W/g, "_")}`, {
    goal: `数据分析：${parent.goal}`, assignee: analyst, parent: parent.id, depth: parent.depth + 1,
    completion: "检查真实业务数据，交付分析报告；结构变更须管理员浏览器确认",
    brief: { analysis: parent.brief?.analysis },
  });
  const sent = await ctx.emit({ reason: "office-task", payloadRef: child.id, employeeId: analyst,
    idempotencyKey: `office-task:${child.id}` });
  if (!sent.accepted) throw new Error("analyst-task-dispatch-failed");
  return child.id;
}

const AnalysisSchema = z.object({
  table: z.string().regex(/^ent_[a-z0-9_]+$/),
  change: z.unknown().optional(),
  rationale: z.string().trim().min(1).max(2000).optional(),
  impact: z.string().trim().min(1).max(2000).optional(),
}).strict();

export async function proposeOfficeDdl(session: TriggerSession, input: {
  task: string; author: string; change: unknown; rationale: string; impact: string; to: string;
  trigger?: string; runId?: string;
}): Promise<{ id: string; notification: string }> {
  const change = normalizeOfficeDdl(input.change);
  if (!input.rationale.trim() || !input.impact.trim()) throw new Error("DDL 理由与影响不能为空");
  const fingerprint = await officeDdlFingerprint(input.task, input.author, change);
  const id = `office_ddl_intent:ddl_${fingerprint}`;
  const notification = `user_notification:ddl_${fingerprint}`;
  const content = {
    id: new StringRecordId(id), task: new StringRecordId(input.task),
    notification: new StringRecordId(notification), op: change.op, spec: change,
    rationale: input.rationale.trim(), impact: input.impact.trim(), fingerprint,
  };
  await session.query("INSERT INTO office_ddl_intent $content ON DUPLICATE KEY UPDATE fingerprint = $content.fingerprint;", { content });
  const [[stored]] = await session.query<[{ author?: unknown }[]]>("SELECT author FROM $intent", { intent: new StringRecordId(id) });
  if (String(stored?.author) !== input.author) throw new Error("ddl-proposal-denied");
  await createOfficeRequest(session, {
    id: notification, dedupeKey: notification, to: input.to, task: input.task,
    questionType: "ddl", ddlIntent: id, prompt: `${input.rationale.trim()}\n预期影响：${input.impact.trim()}`,
    requestTrigger: input.trigger, runId: input.runId,
  });
  return { id, notification };
}

export async function handleAnalystTask(ctx: TriggerHandlerContext, task: OfficeTaskRow): Promise<unknown> {
  const meta = requireOfficeMeta(await readOfficeMeta(ctx.session));
  const analysis = AnalysisSchema.parse(task.brief?.analysis);
  const key = createHash("sha256").update(task.id).digest("hex").slice(0, 24);
  const inspected = await ctx.effects.runEffect("inspect-data", async () => {
    await setOfficeTaskStatus(ctx.session, task.id, "in_progress");
    const [counts] = await ctx.session.query<[{ count: number }[]]>(`SELECT count() FROM ${analysis.table} GROUP ALL`);
    const rows = await ctx.session.query(`SELECT * FROM ${analysis.table} LIMIT 5`);
    const count = counts?.[0]?.count ?? 0;
    await postOfficeMessage(ctx.session, { id: `office_message:analyst_inspect_${key}`, task: task.id,
      to: meta.primaryContact, body: `已通过分析师会话检查 ${analysis.table}：${count} 条可见记录，抽样 ${Array.isArray(rows[0]) ? rows[0].length : 0} 条。` });
    return { count };
  });
  if (analysis.change !== undefined) {
    const [recipients] = await ctx.session.query<[{ id: unknown }[]]>(
      "SELECT id, created_at FROM user WHERE kind = 'human' AND is_admin = true AND disabled_at = NONE ORDER BY created_at LIMIT 1",
    );
    const to = recipients?.[0]?.id;
    if (!to) throw new Error("office-admin-missing");
    const proposal = await ctx.effects.runEffect("propose-ddl", async () => {
      const intent = await proposeOfficeDdl(ctx.session, {
        task: task.id, author: ctx.trigger.employeeId, change: analysis.change,
        rationale: analysis.rationale ?? `分析 ${analysis.table} 需要补充结构`,
        impact: analysis.impact ?? "仅新增结构，不删除或改写已有数据",
        to: String(to), trigger: ctx.trigger.id, runId: ctx.trigger.runId ?? undefined,
      });
      await setOfficeTaskStatus(ctx.session, task.id, "blocked", { waiting_on: intent.notification, ddlIntent: intent.id, count: inspected.count });
      return intent;
    });
    return { taskId: task.id, waiting: proposal.id };
  }
  await ctx.effects.runEffect("analysis-report", () => deliverOfficeReport(ctx.session, {
    id: `office_report:analysis_${key}`, task: task.id, to: meta.primaryContact,
    summary: `已检查 ${analysis.table}：可见记录总数 ${inspected.count}；抽样最多 5 条。未执行结构变更。`,
    nextSteps: ["按业务问题继续分析，需要新增结构时提出明确提案"],
  }));
  await ctx.effects.runEffect("analysis-done", () => setOfficeTaskStatus(ctx.session, task.id, "done", { count: inspected.count }));
  return { taskId: task.id, count: inspected.count };
}

export async function handleAnalystDdlResult(ctx: TriggerHandlerContext, request: OfficeRequestRow): Promise<unknown> {
  const id = request.payload?.ddl_intent;
  if (typeof id !== "string" || !id.startsWith("office_ddl_intent:")) throw new Error("ddl-result-missing-intent");
  const [[intent]] = await ctx.session.query<[{ author?: unknown; status: string; result?: { message?: string }; task?: unknown }[]]>(
    "SELECT author, status, result, task FROM $intent", { intent: new StringRecordId(id) });
  if (!intent || !DDL_TERMINAL.has(intent.status)) throw new Error("ddl-result-not-terminal");
  const task = request.task ? await getOfficeTask(ctx.session, request.task) : null;
  if (!task || task.assignee !== ctx.trigger.employeeId || String(intent.author) !== ctx.trigger.employeeId
    || request.fromEmployee !== ctx.trigger.employeeId || String(intent.task) !== task.id) return { skipped: "unrelated" };
  const waiting = task.result?.waiting_on === request.id && ["blocked", "in_progress"].includes(task.status);
  const finished = task.status === "done" && task.result?.ddlIntent === id;
  if (!waiting && !finished) return { skipped: "not-waiting" };
  const meta = requireOfficeMeta(await readOfficeMeta(ctx.session));
  const key = id.replace(/\W/g, "_");
  if (task.status !== "done") await ctx.effects.runEffect("ddl-resume", () => setOfficeTaskStatus(ctx.session, task.id, "in_progress"));
  await ctx.effects.runEffect("ddl-report", () => deliverOfficeReport(ctx.session, {
    id: `office_report:result_${key}`, task: task.id, to: meta.primaryContact,
    summary: `结构变更结果：${intent.status}。${intent.result?.message ?? ""}。分析检查：${String(task.result?.count ?? "未记录")} 条可见记录。`,
    nextSteps: intent.status === "succeeded" ? ["可按新结构继续分析"] : ["保留已有数据；如仍需变更，指派修订任务并提出新提案"],
  }));
  await ctx.effects.runEffect("ddl-finish", () => setOfficeTaskStatus(ctx.session, task.id, "done", { ddlIntent: id, ddlStatus: intent.status }));
  return { taskId: task.id, intent: id, status: intent.status };
}
