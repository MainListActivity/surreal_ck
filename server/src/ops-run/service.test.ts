import { describe, expect, test } from "bun:test";
import type { OpsRun, SaveOpsRun } from "@surreal-ck/shared";
import { OpsRunService, type OpsRunStore } from "./service";

const agent = { subject: "agent-1", kind: "agent" as const, capabilities: ["activation.followup.read"] };
const human = { subject: "human-1", kind: "human" as const, capabilities: ["activation.autonomy.read"] };
const initial: SaveOpsRun = { runKey: "daily-run-001", workspaceSlug: "team-a", expectedVersion: null, status: "running",
  cursor: null, processedIds: [], pendingAction: null, dueCheckAt: null, retryCount: 0, lastErrorCode: null, actionsCompleted: 0 };
class MemoryStore implements OpsRunStore {
  item: OpsRun | null = null;
  async get(subject: string, workspace: string, key: string) {
    return this.item?.agentSubject === subject && this.item.workspaceSlug === workspace && this.item.runKey === key ? this.item : null;
  }
  async list() { return this.item ? [this.item] : []; }
  async save(subject: string, input: SaveOpsRun) {
    if ((this.item?.version ?? null) !== input.expectedVersion) return null;
    this.item = { ...input, agentSubject: subject, runId: "ops_agent_run:1", version: (this.item?.version ?? 0) + 1, updatedAt: "2026-09-22T12:00:00.000Z" };
    return this.item;
  }
}
describe("ops run checkpoints", () => {
  test("agent 自身检查点版本化；暂停、越界和真人伪报均被拒绝", async () => {
    const store = new MemoryStore();
    let active = true;
    const service = new OpsRunService(store, { authorize: async (actor, _action, workspace) => {
      if (!active) throw { code: "paused" };
      if (actor.subject !== "agent-1" || workspace !== "team-a") throw { code: "out_of_scope" };
    } });
    const created = await service.save(agent, initial);
    expect(created.version).toBe(1);
    expect((await service.get(agent, "team-a", "daily-run-001"))?.runId).toBe(created.runId);
    await expect(service.save(agent, initial)).rejects.toMatchObject({ code: "conflict" });
    await expect(service.save(human, initial)).rejects.toMatchObject({ code: "agent_required" });
    await expect(service.list(agent)).rejects.toMatchObject({ code: "human_required" });
    expect((await service.list(human)).items).toHaveLength(1);
    active = false;
    await expect(service.save(agent, { ...initial, expectedVersion: 1 })).rejects.toMatchObject({ code: "paused" });
  });
});
