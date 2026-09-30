import type { EmployeeTriggerRuntime, TriggerHandlerContext } from "./employee-trigger-runtime";

/**
 * qa-probe：内部受控 trigger 投递诊断口的 handler（VER 联验补齐）。
 *
 * 用途：QA/排障需要对任意夹具员工验证"投递 → SIGNIN → 窗口 → durable run →
 * effect 账本"这条真实执行链是否可用，又不触碰任何业务表。handler 本体只经
 * runEffect 记一行确定性账本（probe:true），返回结果可含 payload_ref 回显，
 * 方便核对投递内容是否原样到达。
 *
 * 投递入口是 POST /api/internal/workspaces/:slug/employees/:employeeKey/triggers
 * （reason 固定本值），由目标 workspace 的 admin token 调用；员工暂停/退休或
 * 缺凭证时 enqueue 在 SIGNIN 阶段即失败返回，触发不落库。
 *
 * 边界：不写任何业务表、不读外部服务、不消耗模型额度；账本行是 runtime 自身
 * 簿记。同一幂等键重放直接回 committed 结果，天然演示 effect 幂等语义。
 */

export const QA_PROBE_REASON = "qa-probe";

async function qaProbeHandler(ctx: TriggerHandlerContext): Promise<unknown> {
  return ctx.effects.runEffect("qa-probe", async () => ({
    probe: true,
    triggerId: ctx.trigger.id,
    employeeId: ctx.trigger.employeeId,
    payloadRef: ctx.trigger.payloadRef ?? null,
  }));
}

/** 把 qa-probe handler 挂到共享 trigger runtime；重复调用幂等（map 覆盖语义）。 */
export function registerQaProbeHandler(
  runtime: Pick<EmployeeTriggerRuntime, "registerHandler">,
): void {
  runtime.registerHandler(QA_PROBE_REASON, qaProbeHandler);
}
