import { saveOpsRunSchema, type OpsRun, type SaveOpsRun } from "@surreal-ck/shared";
import type { OpsAutonomyActor, OpsAutonomyService } from "../ops-autonomy/service";

export class OpsRunError extends Error {
  constructor(readonly code: "invalid_request" | "conflict" | "not_found" | "human_required" | "agent_required" | "capability_missing", message: string) {
    super(message); this.name = "OpsRunError";
  }
}
export interface OpsRunStore {
  get(agentSubject: string, workspaceSlug: string, runKey: string): Promise<OpsRun | null>;
  list(): Promise<OpsRun[]>;
  save(agentSubject: string, input: SaveOpsRun): Promise<OpsRun | null>;
}
export class OpsRunService {
  constructor(private readonly store: OpsRunStore, private readonly autonomy: Pick<OpsAutonomyService, "authorize">) {}

  async get(actor: OpsAutonomyActor, workspaceSlug: string, runKey: string): Promise<OpsRun | null> {
    if (actor.kind !== "agent") throw new OpsRunError("agent_required", "仅 agent 可读取自身运行检查点");
    await this.autonomy.authorize(actor, "opportunity.read", workspaceSlug);
    return await this.store.get(actor.subject, workspaceSlug, runKey);
  }

  async save(actor: OpsAutonomyActor, input: unknown): Promise<OpsRun> {
    if (actor.kind !== "agent") throw new OpsRunError("agent_required", "仅 agent 可报告自身运行检查点");
    const parsed = saveOpsRunSchema.safeParse(input);
    if (!parsed.success) throw new OpsRunError("invalid_request", "运行检查点不符合契约");
    await this.autonomy.authorize(actor, "opportunity.read", parsed.data.workspaceSlug);
    const saved = await this.store.save(actor.subject, parsed.data);
    if (!saved) throw new OpsRunError("conflict", "运行检查点版本已变化");
    return saved;
  }

  async list(actor: OpsAutonomyActor): Promise<{ items: OpsRun[] }> {
    if (actor.kind !== "human") throw new OpsRunError("human_required", "仅真人运营人员可查看运行状态");
    if (!actor.capabilities.includes("activation.autonomy.read")) throw new OpsRunError("capability_missing", "缺少运行状态读取权限");
    return { items: await this.store.list() };
  }
}
