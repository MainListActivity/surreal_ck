import { createHash } from "node:crypto";
import { changeOpsAutonomyStatusSchema, configureOpsAutonomySchema, type OpsAutonomyAction, type OpsAutonomyAudit, type OpsAutonomyPolicy } from "@surreal-ck/shared";

export type OpsAutonomyActor = { subject: string; kind?: "human" | "agent"; capabilities: readonly string[] };
const requiredCapabilities: Record<OpsAutonomyAction, readonly string[]> = {
  "activation.summary.read": ["activation.summary.read"],
  "opportunity.read": ["activation.followup.read"],
  "follow_up.read": ["activation.followup.read"],
  "follow_up.create": ["activation.followup.read", "activation.followup.write"],
  "follow_up.claim": ["activation.followup.read", "activation.followup.write"],
  "follow_up.update": ["activation.followup.read", "activation.followup.write"],
  "proposal.read": ["activation.proposal.read"],
  "proposal.submit": ["activation.proposal.read", "activation.proposal.submit", "activation.followup.read"],
  "proposal.execute": ["activation.proposal.read", "activation.proposal.execute", "activation.followup.read", "activation.followup.write"],
};
export class OpsAutonomyError extends Error {
  constructor(readonly code: "invalid_request" | "capability_missing" | "human_required" | "agent_required" | "out_of_scope" | "paused" | "revoked" | "conflict" | "not_found", message: string) {
    super(message); this.name = "OpsAutonomyError";
  }
}
export interface OpsAutonomyStore {
  getOperatorKind(subject: string): Promise<"human" | "agent" | null>;
  getOperatorCapabilities(subject: string): Promise<readonly string[]>;
  workspaceExists(workspaceSlug: string): Promise<boolean>;
  listPolicies(agentSubject?: string): Promise<OpsAutonomyPolicy[]>;
  listAudit(policyId?: string): Promise<OpsAutonomyAudit[]>;
  getPolicy(agentSubject: string, workspaceSlug: string): Promise<OpsAutonomyPolicy | null>;
  getById(policyId: string): Promise<OpsAutonomyPolicy | null>;
  findIdempotent(actorSubject: string, idempotencyKey: string): Promise<{ policy: OpsAutonomyPolicy; requestDigest: string } | null>;
  save(input: { agentSubject: string; workspaceSlug: string; actions: OpsAutonomyAction[]; status: OpsAutonomyPolicy["status"];
    expectedVersion: number | null; event: OpsAutonomyAudit["event"]; reason: string; actorSubject: string;
    idempotencyKey: string; requestDigest: string }): Promise<OpsAutonomyPolicy | null>;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireCaps(actor: OpsAutonomyActor, capabilities: readonly string[]): void {
  for (const capability of capabilities) if (!actor.capabilities.includes(capability)) throw new OpsAutonomyError("capability_missing", `缺少 ${capability} 能力或 OAuth scope`);
}
function manager(actor: OpsAutonomyActor, write: boolean): void {
  if (actor.kind !== "human") throw new OpsAutonomyError("human_required", "只有真人运营人员可配置自治范围");
  requireCaps(actor, write ? ["activation.autonomy.read", "activation.autonomy.manage"] : ["activation.autonomy.read"]);
}
export class OpsAutonomyService {
  constructor(private readonly store: OpsAutonomyStore) {}

  async list(actor: OpsAutonomyActor, agentSubject?: string): Promise<{ items: OpsAutonomyPolicy[] }> {
    manager(actor, false);
    return { items: await this.store.listPolicies(agentSubject) };
  }
  async history(actor: OpsAutonomyActor, policyId?: string): Promise<{ items: OpsAutonomyAudit[] }> {
    manager(actor, false);
    return { items: await this.store.listAudit(policyId) };
  }
  private async replay(actor: OpsAutonomyActor, key: string, requestDigest: string): Promise<OpsAutonomyPolicy | null> {
    const found = await this.store.findIdempotent(actor.subject, key);
    if (!found) return null;
    if (found.requestDigest !== requestDigest) throw new OpsAutonomyError("conflict", "幂等键已用于不同配置请求");
    return found.policy;
  }
  async configure(actor: OpsAutonomyActor, input: unknown): Promise<OpsAutonomyPolicy> {
    manager(actor, true);
    const parsed = configureOpsAutonomySchema.safeParse(input);
    if (!parsed.success) throw new OpsAutonomyError("invalid_request", "自治配置无效");
    const body = parsed.data;
    const actions = [...new Set(body.actions)].sort();
    const requestDigest = digest({ event: "configured", ...body, actions });
    const replay = await this.replay(actor, body.idempotencyKey, requestDigest);
    if (replay) return replay;
    const existing = await this.store.getPolicy(body.agentSubject, body.workspaceSlug);
    if (existing?.status === "revoked") throw new OpsAutonomyError("revoked", "已撤销的授权不可通过配置恢复，请建立新的授权流程");
    if (existing?.status === "paused") throw new OpsAutonomyError("paused", "请先通过恢复操作解除暂停，再调整动作范围");
    if (await this.store.getOperatorKind(body.agentSubject) !== "agent") throw new OpsAutonomyError("agent_required", "目标必须是已登记 agent 运营主体");
    if (!(await this.store.workspaceExists(body.workspaceSlug))) throw new OpsAutonomyError("not_found", "工作区不存在或已停用");
    const agentCapabilities = await this.store.getOperatorCapabilities(body.agentSubject);
    for (const action of actions) {
      requireCaps(actor, requiredCapabilities[action]);
      for (const capability of requiredCapabilities[action]) if (!agentCapabilities.includes(capability)) throw new OpsAutonomyError("capability_missing", `目标 agent 缺少 ${capability} 能力`);
    }
    const saved = await this.store.save({ agentSubject: body.agentSubject, workspaceSlug: body.workspaceSlug, actions, status: "active",
      expectedVersion: body.expectedVersion, event: "configured", reason: "人工配置动作范围", actorSubject: actor.subject,
      idempotencyKey: body.idempotencyKey, requestDigest });
    if (!saved) throw new OpsAutonomyError("conflict", "自治配置版本已变化");
    return saved;
  }
  async changeStatus(actor: OpsAutonomyActor, input: { policyId: string; expectedVersion: number; status: "active" | "paused" | "revoked"; reason: string; idempotencyKey: string }): Promise<OpsAutonomyPolicy> {
    manager(actor, true);
    if (!input.policyId.startsWith("ops_agent_policy:") || !changeOpsAutonomyStatusSchema.safeParse({ expectedVersion: input.expectedVersion, reason: input.reason, idempotencyKey: input.idempotencyKey }).success) {
      throw new OpsAutonomyError("invalid_request", "状态变更请求无效");
    }
    const requestDigest = digest({ event: "status", input });
    const replay = await this.replay(actor, input.idempotencyKey, requestDigest);
    if (replay) return replay;
    const policy = await this.store.getById(input.policyId);
    if (!policy) throw new OpsAutonomyError("not_found", "自治配置不存在");
    if (policy.version !== input.expectedVersion || policy.status === "revoked" || policy.status === input.status) throw new OpsAutonomyError("conflict", "配置状态或版本已变化");
    if (input.status === "active") {
      if (!(await this.store.workspaceExists(policy.workspaceSlug))) throw new OpsAutonomyError("not_found", "工作区不存在或已停用");
      if (await this.store.getOperatorKind(policy.agentSubject) !== "agent") throw new OpsAutonomyError("agent_required", "目标已不是有效 agent");
      const targetCapabilities = await this.store.getOperatorCapabilities(policy.agentSubject);
      for (const action of policy.actions) {
        requireCaps(actor, requiredCapabilities[action]);
        for (const capability of requiredCapabilities[action]) if (!targetCapabilities.includes(capability)) throw new OpsAutonomyError("capability_missing", `目标 agent 缺少 ${capability} 能力`);
      }
    }
    const event = input.status === "active" ? "resumed" : input.status === "paused" ? "paused" : "revoked";
    const saved = await this.store.save({ agentSubject: policy.agentSubject, workspaceSlug: policy.workspaceSlug, actions: policy.actions,
      status: input.status, expectedVersion: input.expectedVersion, event, reason: input.reason, actorSubject: actor.subject,
      idempotencyKey: input.idempotencyKey, requestDigest });
    if (!saved) throw new OpsAutonomyError("conflict", "配置状态已由其他人变更");
    return saved;
  }
  async allowedWorkspaces(actor: OpsAutonomyActor, action: OpsAutonomyAction): Promise<string[] | null> {
    requireCaps(actor, requiredCapabilities[action]);
    if (actor.kind === "human") return null;
    if (actor.kind !== "agent") throw new OpsAutonomyError("agent_required", "运营主体类型未确认");
    const policies = await this.store.listPolicies(actor.subject);
    const allowed = policies.filter((policy) => policy.status === "active" && policy.actions.includes(action)).map((policy) => policy.workspaceSlug);
    if (allowed.length > 0) return allowed;
    if (policies.some((policy) => policy.status === "paused" && policy.actions.includes(action))) throw new OpsAutonomyError("paused", "agent 自动动作已暂停");
    if (policies.some((policy) => policy.status === "revoked" && policy.actions.includes(action))) throw new OpsAutonomyError("revoked", "agent 自动动作授权已撤销");
    throw new OpsAutonomyError("out_of_scope", "agent 没有该动作的授权工作区");
  }
  async authorize(actor: OpsAutonomyActor, action: OpsAutonomyAction, workspaceSlug: string): Promise<void> {
    requireCaps(actor, requiredCapabilities[action]);
    if (actor.kind === "human") return;
    if (actor.kind !== "agent") throw new OpsAutonomyError("agent_required", "运营主体类型未确认");
    const policy = await this.store.getPolicy(actor.subject, workspaceSlug);
    if (!policy) throw new OpsAutonomyError("out_of_scope", "agent 不在该工作区的授权范围内");
    if (policy.status === "paused") throw new OpsAutonomyError("paused", "agent 自动动作已暂停");
    if (policy.status === "revoked") throw new OpsAutonomyError("revoked", "agent 自动动作授权已撤销");
    if (!policy.actions.includes(action)) throw new OpsAutonomyError("out_of_scope", "动作不在 agent 白名单内");
  }
}
