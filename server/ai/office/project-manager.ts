import {
  createOfficeRequest,
  createOfficeTaskOnce,
  delegateOfficeTask,
  deliverOfficeReport,
  getOfficeRequest,
  getOfficeTask,
  OFFICE_INITIAL_TASK_ID,
  officeRequestId,
  postOfficeMessage,
  readOfficeMeta,
  requireOfficeMeta,
  setOfficeTaskStatus,
  type OfficeTaskRow,
} from "./office-domain";
import type {
  EmployeeTriggerRuntime,
  TriggerHandlerContext,
} from "./employee-trigger-runtime";

/**
 * 虚拟项目经理的岗位实现（VO02 tracer）。
 *
 * 投递链路：office trigger adapter 把领域变化翻译成通用 trigger → 通用 runtime
 * 负责会话/窗口/持久化 → 本模块的两个 handler 在 PM 自己的 RECORD 会话里写
 * office_task / office_message / office_report。本模块不建会话池、不重试、不管
 * 预算——那些都归 runtime。
 *
 * reason：
 * - "office-bootstrap"：管理员完成 onboarding 后的开岗触发。PM 读持久
 *   office_meta，创建有边界的初始任务（确定性 id + completion 条件 + 合法
 *   assignee/parent/depth），再经 ctx.emit 把新任务翻译成级联触发投递回
 *   runtime——新任务事件走 adapter 的同一条投递路径。
 * - "office-task"：任务指派/状态变化。PM 承接自己名下的任务：置 in_progress、
 *   发可见进度消息、（可选）执行 brief.delegate_to 委派或 brief.attempt_ddl
 *   结构变更尝试——领域/数据库边界拒绝时写诊断消息而不是吞错——然后向
 *   primary contact 交付持久报告并置 done。
 *
 * tracer 阶段 PM 不消耗模型额度：承接/执行/报告是确定性的。模型驱动的目标
 * 拆解留给后续版本；MeteredModel 闸门已在 handler ctx 里就位。
 */

export const OFFICE_BOOTSTRAP_REASON = "office-bootstrap";
export const OFFICE_TASK_REASON = "office-task";
/** 人类请求终态回流：收件人答复/拒绝/取消落库后，adapter 以此 reason 唤醒请求员工。 */
export const OFFICE_REQUEST_REASON = "office-request-resolved";

/** 初始任务的幂等投递键：同一任务无论经哪条路径投递都撞同一键。 */
export function officeTaskTriggerKey(taskId: string): string {
  return `office-task:${taskId}`;
}

/** 人类请求的幂等投递键：一条通知的解决只唤醒一次逻辑后续执行。 */
export function officeRequestTriggerKey(notificationId: string): string {
  return `office-request:${notificationId}`;
}

function recordKey(recordId: string): string {
  return recordId.replace(/[^a-zA-Z0-9_]/g, "_");
}

type OfficeTaskBrief = {
  /** 委派指令：把本任务拆出的子任务派给指定员工/成员。 */
  delegate_to?: string;
  delegate_goal?: string;
  /** DDL 尝试指令（诊断边界用）：PM 拿自己会话直接执行这条语句，必被拒。 */
  attempt_ddl?: string;
  /** 人类请求指令：先向收件人发结构化问题并把任务挂 blocked，终态回流后继续。 */
  ask_human?: { prompt?: unknown; to?: unknown; question_type?: unknown; options?: unknown };
};

function parseBrief(task: OfficeTaskRow): OfficeTaskBrief {
  const brief = task.brief ?? {};
  const ask = brief.ask_human && typeof brief.ask_human === "object"
    ? (brief.ask_human as Record<string, unknown>)
    : undefined;
  return {
    delegate_to: typeof brief.delegate_to === "string" ? brief.delegate_to : undefined,
    delegate_goal: typeof brief.delegate_goal === "string" ? brief.delegate_goal : undefined,
    attempt_ddl: typeof brief.attempt_ddl === "string" ? brief.attempt_ddl : undefined,
    ask_human: ask
      ? {
          prompt: ask.prompt,
          to: ask.to,
          question_type: ask.question_type,
          options: ask.options,
        }
      : undefined,
  };
}

/** 边界拒绝统一落成可见、可诊断的 office_message，附在父任务上。 */
async function recordRejection(
  session: TriggerHandlerContext["session"],
  input: { taskId: string; kind: string; detail: string; to?: string | null },
): Promise<void> {
  await postOfficeMessage(session, {
    id: `office_message:pm_reject_${input.kind}_${recordKey(input.taskId)}`,
    task: input.taskId,
    to: input.to ?? undefined,
    body: `办公室边界拒绝[${input.kind}]：${input.detail}`,
  });
}

async function handleBootstrap(ctx: TriggerHandlerContext): Promise<unknown> {
  const meta = requireOfficeMeta(await readOfficeMeta(ctx.session));
  const task = await ctx.effects.runEffect("initial-task", () =>
    createOfficeTaskOnce(ctx.session, OFFICE_INITIAL_TASK_ID, {
      goal: meta.goal,
      // 初始任务由 PM 自己承接：assignee 合法（active virtual），parent/depth=0 有界。
      assignee: ctx.trigger.employeeId,
      completion: `承接目标「${meta.goal}」：发布可见进度，并向 primary contact 交付一份含目标确认与后续步骤的持久报告`,
      brief: { source: "office-bootstrap" },
    }),
  );
  // 新任务事件经同一 adapter 投递键回到 runtime；emit 的链深由 runtime 继承 +1。
  const emitted = await ctx.emit({
    reason: OFFICE_TASK_REASON,
    payloadRef: task.id,
    idempotencyKey: officeTaskTriggerKey(task.id),
  });
  if (!emitted.accepted) {
    throw new Error(`office-task-dispatch-failed:${emitted.rejected}:${emitted.error ?? ""}`);
  }
  return { taskId: task.id, taskTrigger: emitted.triggerId };
}

async function handleOfficeTask(ctx: TriggerHandlerContext): Promise<unknown> {
  const taskId = ctx.trigger.payloadRef;
  if (!taskId) throw new Error("office-task-missing-ref");
  const task = await getOfficeTask(ctx.session, taskId);
  if (!task) throw new Error(`office-task-not-found:${taskId}`);
  // 只承接派给自己的任务；路由错误（adapter 指错员工）如实跳过并留痕。
  if (task.assignee !== ctx.trigger.employeeId) {
    return { skipped: "not-assignee", assignee: task.assignee };
  }
  if (task.status === "done" || task.status === "cancelled") {
    return { skipped: "task-terminal", status: task.status };
  }
  const meta = requireOfficeMeta(await readOfficeMeta(ctx.session));
  const brief = parseBrief(task);

  // 承接：状态推进 + 可见进度（确定性 id，重放不产生第二条消息）。
  await ctx.effects.runEffect("accept", async () => {
    await setOfficeTaskStatus(ctx.session, task.id, "in_progress");
    await postOfficeMessage(ctx.session, {
      id: `office_message:pm_accept_${recordKey(task.id)}`,
      task: task.id,
      to: meta.primaryContact,
      body: `已承接任务「${task.goal}」，完成条件：${task.completion ?? "交付结果报告"}。`,
    });
    return { accepted: task.id };
  });

  const rejections: string[] = [];
  let delegatedTo: string | null = null;

  // 人类请求：建结构化通知（确定性 id，重试收敛）→ 进度消息 → 任务 blocked。
  // 本次 run 到此结束；收件人答复/拒绝/取消落库后由 office-request-resolved
  // 触发续跑（幂等键 = office-request:<notificationId>，恰好一次后续执行）。
  const askPrompt = typeof brief.ask_human?.prompt === "string" ? brief.ask_human.prompt.trim() : "";
  if (brief.ask_human && askPrompt) {
    const asked = await ctx.effects.runEffect("ask-human", async () => {
      const recipient = typeof brief.ask_human!.to === "string" && brief.ask_human!.to
        ? brief.ask_human!.to
        : meta.primaryContact;
      const requestId = officeRequestId(task.id, askPrompt);
      const questionType =
        typeof brief.ask_human!.question_type === "string" && brief.ask_human!.question_type
          ? brief.ask_human!.question_type
          : "free-text";
      const options = Array.isArray(brief.ask_human!.options)
        ? brief.ask_human!.options.filter((o): o is string => typeof o === "string")
        : undefined;
      await createOfficeRequest(ctx.session, {
        id: requestId,
        dedupeKey: requestId,
        to: recipient,
        task: task.id,
        questionType,
        prompt: askPrompt,
        options,
        requestTrigger: ctx.trigger.id,
        runId: ctx.trigger.runId ?? undefined,
      });
      await postOfficeMessage(ctx.session, {
        id: `office_message:pm_ask_${recordKey(task.id)}`,
        task: task.id,
        to: meta.primaryContact,
        body: `已就任务「${task.goal}」向 ${recipient} 发起人类请求 ${requestId}：${askPrompt}`,
      });
      await setOfficeTaskStatus(ctx.session, task.id, "blocked", { waiting_on: requestId });
      return { requestId, recipient };
    });
    return { taskId: task.id, waiting: asked.requestId, rejections };
  }

  if (brief.delegate_to) {
    const outcome = await ctx.effects.runEffect("delegate", async () => {
      try {
        const { task: child, assigneeKind } = await delegateOfficeTask(ctx.session, task, {
          assignee: brief.delegate_to!,
          goal: brief.delegate_goal ?? `承接子任务：${task.goal}`,
          completion: brief.delegate_goal ? `交付「${brief.delegate_goal}」的结果` : `交付「${task.goal}」的子任务结果`,
        });
        // 真人 assignee 没有 employee 执行 lane——任务行对其可见即可，不投触发。
        const emitted = assigneeKind === "virtual"
          ? await ctx.emit({
              reason: OFFICE_TASK_REASON,
              payloadRef: child.id,
              employeeId: brief.delegate_to,
              idempotencyKey: officeTaskTriggerKey(child.id),
            })
          : { accepted: true as const, triggerId: undefined, chainDepth: ctx.trigger.chainDepth + 1 };
        return { childId: child.id, emitted: emitted.accepted };
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        await recordRejection(ctx.session, {
          taskId: task.id,
          kind: "delegation",
          detail,
          to: meta.primaryContact,
        });
        return { rejected: detail };
      }
    });
    if ("childId" in outcome) delegatedTo = String(outcome.childId);
    if ("rejected" in outcome) rejections.push(`delegation:${outcome.rejected}`);
  }

  if (brief.attempt_ddl) {
    const outcome = await ctx.effects.runEffect("ddl-attempt", async () => {
      try {
        await ctx.session.query(brief.attempt_ddl!);
        return { executed: true };
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        await recordRejection(ctx.session, {
          taskId: task.id,
          kind: "ddl",
          detail,
          to: meta.primaryContact,
        });
        return { rejected: detail };
      }
    });
    if ("rejected" in outcome) rejections.push(`ddl:${outcome.rejected}`);
  }

  // 交付：持久报告发给 primary contact（确定性 id，重放只有一行）。
  // 报告措辞与任务 completion 对齐：只陈述本 handler 实际完成的链路动作；
  // 目标拆解与执行指派是人类的后续步骤，不在这里宣告完成。
  const summary = rejections.length
    ? `任务「${task.goal}」执行受阻：${rejections.join("；")}`
    : `任务「${task.goal}」已完成：已承接、发布可见进度并向 primary contact 交付持久报告。`;
  const nextSteps = delegatedTo
    ? [`跟进子任务执行（assignee=${delegatedTo}）`]
    : rejections.length
      ? [`由管理员修正边界条件后重新指派或调整任务「${task.goal}」`]
      : [
          `由 primary contact 确认目标「${task.goal}」的范围与优先级`,
          "确认后指派后续执行任务（当前在岗员工仅项目经理，可经 bootstrap 增开岗位或派给真人成员）",
        ];
  await ctx.effects.runEffect("report", () =>
    deliverOfficeReport(ctx.session, {
      id: `office_report:pm_report_${recordKey(task.id)}`,
      task: task.id,
      to: meta.primaryContact,
      summary,
      nextSteps,
      blockedBy: rejections.length ? rejections.join("；") : undefined,
    }),
  );

  await ctx.effects.runEffect("done", () =>
    setOfficeTaskStatus(ctx.session, task.id, "done", {
      rejected: rejections,
      delegatedTo,
      reportId: `office_report:pm_report_${recordKey(task.id)}`,
    }),
  );
  return { taskId: task.id, delegatedTo, rejections };
}

const REQUEST_ACTION_LABEL: Record<string, string> = {
  answered: "已答复",
  rejected: "已拒绝",
  cancelled: "已取消",
};

/**
 * 人类请求终态回流（VO03）：收件人把 resolution/answer/resolved_at 写进
 * user_notification 后，adapter 以 office-request:<notificationId> 幂等键投递
 * 本触发。员工在自己的会话里读回终态（select 放行 from_employee），把答复落
 * 成可见消息并继续被 blocked 的任务；重复唤醒撞同一幂等键被 runtime 收敛。
 */
async function handleOfficeRequestResolved(ctx: TriggerHandlerContext): Promise<unknown> {
  const notificationId = ctx.trigger.payloadRef;
  if (!notificationId) throw new Error("office-request-missing-ref");
  const request = await getOfficeRequest(ctx.session, notificationId);
  if (!request) throw new Error(`office-request-not-found:${notificationId}`);
  if (request.purpose !== "office-request") {
    return { skipped: "not-office-request", purpose: request.purpose };
  }
  // 唤醒只应发生在终态之后；未解决的记录如实跳过（reconcile 不会补投它们）。
  if (!request.resolvedAt) return { skipped: "unresolved" };

  const action = typeof request.answer?.action === "string" ? request.answer.action : "answered";
  const note = typeof request.answer?.text === "string" && request.answer.text
    ? request.answer.text
    : request.resolution ?? "";
  const actionLabel = REQUEST_ACTION_LABEL[action] ?? action;
  const task = request.task ? await getOfficeTask(ctx.session, request.task) : null;
  const meta = await readOfficeMeta(ctx.session);
  const audience = meta?.primaryContact ?? request.toUser ?? undefined;

  const key = recordKey(notificationId);
  await ctx.effects.runEffect("answer-message", () =>
    postOfficeMessage(ctx.session, {
      id: `office_message:pm_answer_${key}`,
      task: task?.id,
      to: audience,
      body:
        `人类请求 ${notificationId} ${actionLabel}` +
        (note ? `：${note}` : "。") +
        (task ? `（关联任务「${task.goal}」）` : ""),
    }),
  );

  // 被该请求阻塞的任务：继续推进——交付含人类终态的报告并收 done。
  // 非 blocked（未等待/已终态）只留答复消息，不强行改状态。
  if (task && task.status === "blocked") {
    await ctx.effects.runEffect("resume-task", () =>
      setOfficeTaskStatus(ctx.session, task.id, "in_progress"),
    );
    const reportTo = meta?.primaryContact ?? request.toUser;
    if (reportTo) {
      await ctx.effects.runEffect("answer-report", () =>
        deliverOfficeReport(ctx.session, {
          id: `office_report:pm_answer_${recordKey(task.id)}`,
          task: task.id,
          to: reportTo,
          summary:
            `任务「${task.goal}」等待的人类请求${actionLabel}` +
            (note ? `：${note}` : "。") +
            "据此完成后续执行并交付本报告。",
          nextSteps: ["如需进一步澄清，可发起新的人类请求或直接修订任务"],
        }),
      );
    }
    await ctx.effects.runEffect("finish-task", () =>
      setOfficeTaskStatus(ctx.session, task.id, "done", {
        requestId: notificationId,
        answerAction: action,
      }),
    );
    return { notificationId, taskId: task.id, action, continued: true };
  }
  return { notificationId, taskId: task?.id ?? null, action, continued: false };
}

/** 把 PM 的 reason 挂到通用 runtime；重复调用幂等（map 覆盖语义）。 */
export function registerProjectManagerHandlers(
  runtime: Pick<EmployeeTriggerRuntime, "registerHandler">,
): void {
  runtime.registerHandler(OFFICE_BOOTSTRAP_REASON, handleBootstrap);
  runtime.registerHandler(OFFICE_TASK_REASON, handleOfficeTask);
  runtime.registerHandler(OFFICE_REQUEST_REASON, handleOfficeRequestResolved);
}
