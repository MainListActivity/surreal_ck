import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { PlatformOperatorCapability } from "@surreal-ck/shared/native-quota";
import { z } from "zod";
import { StringRecordId } from "surrealdb";
import { env } from "../env";
import type { AppBindings } from "../hono-types";
import { HttpError } from "../http-error";
import { getRootDatabaseSession } from "../db/root-connection";
import { requirePlatformOperator } from "../ops/operator-auth";
import { readSwitchRow, type CapabilitySwitchKey, type Queryable } from "../capability/switch";

/**
 * LCA-14 返工：灰度开关与批次记录的运营端点。
 *
 * - GET  /api/ops/capability-switches          quota.read：列出全部开关行与批次。
 * - PUT  /api/ops/capability-switches/:key     capability.switch：置 mode/cohort
 *        白名单/说明；off 立即关闭新会话签发与新的 AI run（已下发会话不追溯）。
 * - POST /api/ops/capability-switches/batches  capability.switch：追加一条灰度
 *        批次记录（该波放行的 workspace slug 列表 + 说明），幂等键去重。
 */

const CAPABILITY_KEYS = ["content", "ai"] as const;

const setSwitchSchema = z.object({
  mode: z.enum(["on", "cohort", "off"]),
  /** cohort 模式放行的工作区 slug 列表；on/off 模式下仅作存档说明，求值忽略。 */
  workspaces: z.array(z.string().min(1)).default([]),
  note: z.string().max(500).default(""),
}).strict();

const batchSchema = z.object({
  capability: z.enum(CAPABILITY_KEYS),
  workspaces: z.array(z.string().min(1)),
  note: z.string().max(500).default(""),
  /** 幂等键：重复提交同一批次记录不重复建行。 */
  idempotencyKey: z.string().min(8).max(120),
}).strict();

const batchIdFor = (capability: string, idempotencyKey: string) =>
  new StringRecordId(`platform_rollout_batch:${capability}_${idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96)}`);

export function createOpsCapabilitySwitchRoutes(input?: {
  getSystemDb?: () => Promise<Queryable>;
  /** 测试可注入的鉴权工厂；默认按能力位走 requirePlatformOperator。 */
  requireOperator?: (capability: PlatformOperatorCapability) => MiddlewareHandler<AppBindings>;
}) {
  const getSystemDb = input?.getSystemDb ?? (() => getRootDatabaseSession("_system", env.SURREAL_NS));
  const requireOperator = input?.requireOperator ?? ((cap) => requirePlatformOperator(cap));

  return new Hono<AppBindings>()
    .get("/api/ops/capability-switches", requireOperator("quota.read"), async (c) => {
      const system = await getSystemDb();
      const rows = await system.query(
        `SELECT * FROM platform_capability_switch ORDER BY id ASC;`,
      );
      const statement = Array.isArray(rows) ? rows[0] : rows;
      const list = (Array.isArray(statement) ? statement : []).map((row) => ({
        key: String((row as { id?: unknown }).id ?? "").replace("platform_capability_switch:", ""),
        ...readSwitchRow(row),
      }));
      return c.json({ switches: list });
    })
    .get("/api/ops/capability-switches/batches", requireOperator("quota.read"), async (c) => {
      const system = await getSystemDb();
      const rows = await system.query(
        `SELECT capability, workspaces, note, created_by, created_at FROM platform_rollout_batch ORDER BY created_at DESC LIMIT 100;`,
      );
      const statement = Array.isArray(rows) ? rows[0] : rows;
      return c.json({ batches: Array.isArray(statement) ? statement : [] });
    })
    .put("/api/ops/capability-switches/:key", requireOperator("capability.switch"), async (c) => {
      const key = c.req.param("key") as CapabilitySwitchKey;
      if (!(CAPABILITY_KEYS as readonly string[]).includes(key)) {
        throw new HttpError(404, "capability-switch-unknown", "能力键不存在（content / ai）");
      }
      const parsed = setSwitchSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HttpError(400, "capability-switch-invalid", "开关请求无效", parsed.error.flatten());
      }
      const operator = c.var.platformOperator;
      const system = await getSystemDb();
      await system.query(
        `
        UPSERT $id CONTENT {
          mode: $mode, workspaces: $workspaces, note: $note,
          updated_by: $by, updated_at: time::now()
        };
        `,
        {
          id: new StringRecordId(`platform_capability_switch:${key}`),
          mode: parsed.data.mode,
          workspaces: parsed.data.workspaces,
          note: parsed.data.note,
          by: operator?.subject ?? "unknown",
        },
      );
      return c.json({ key, ...parsed.data, updatedBy: operator?.subject ?? "unknown" });
    })
    .post("/api/ops/capability-switches/batches", requireOperator("capability.switch"), async (c) => {
      const parsed = batchSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HttpError(400, "capability-batch-invalid", "批次记录无效", parsed.error.flatten());
      }
      const operator = c.var.platformOperator;
      const system = await getSystemDb();
      const id = batchIdFor(parsed.data.capability, parsed.data.idempotencyKey);
      await system.query(
        `
        INSERT INTO platform_rollout_batch {
          id: $id, capability: $capability, workspaces: $workspaces,
          note: $note, created_by: $by
        } ON DUPLICATE KEY UPDATE note = note;
        `,
        {
          id,
          capability: parsed.data.capability,
          workspaces: parsed.data.workspaces,
          note: parsed.data.note,
          by: operator?.subject ?? "unknown",
        },
      );
      return c.json({ id: id.toString(), ...parsed.data }, 201);
    });
}
