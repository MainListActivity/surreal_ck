import { StringRecordId } from "surrealdb";
import {
  compileOfficeDdl, DDL_TERMINAL, normalizeOfficeDdl, officeDdlFingerprint,
  OfficeDdlStatusSchema, type OfficeDdlChange, type OfficeDdlStatus,
} from "./office-ddl";
export type DdlQueryConnection = {
  query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T[]>;
};
export type DdlTransactionWriter = DdlQueryConnection;
export type DdlConnection = DdlQueryConnection & {
  transaction<T>(run: (tx: DdlTransactionWriter) => Promise<T>): Promise<T>;
};

export type OfficeDdlIntent = {
  id: string; author: string; task: string; notification: string;
  change: OfficeDdlChange; sql: string; rationale: string; impact: string;
  fingerprint: string; status: OfficeDdlStatus; result: Record<string, unknown> | null;
};


/** 直接使用办公室当前浏览器连接；完全不接收 token，也不调用后端 DDL 接口。 */
export async function readOfficeDdl(conn: DdlQueryConnection, id: string): Promise<OfficeDdlIntent> {
  if (!id.startsWith("office_ddl_intent:")) throw new Error("结构变更请求 ID 不合法");
  const [row] = await conn.query<Record<string, unknown>>("SELECT * FROM $intent", { intent: new StringRecordId(id) });
  if (!row) throw new Error("结构变更请求不存在或不可见");
  const change = normalizeOfficeDdl(row.spec);
  if (row.op !== change.op) throw new Error("结构变更类型不一致");
  const task = String(row.task);
  const author = String(row.author);
  const fingerprint = await officeDdlFingerprint(task, author, change);
  if (row.fingerprint !== fingerprint) throw new Error("结构变更指纹不一致，拒绝执行");
  return {
    id: String(row.id), task, author, notification: String(row.notification), change,
    sql: compileOfficeDdl(change), rationale: String(row.rationale), impact: String(row.impact), fingerprint,
    status: OfficeDdlStatusSchema.parse(row.status),
    result: row.result && typeof row.result === "object" ? row.result as Record<string, unknown> : null,
  };
}

async function transition(conn: DdlQueryConnection, intent: OfficeDdlIntent,
  from: OfficeDdlStatus, to: OfficeDdlStatus, result: Record<string, unknown>): Promise<boolean> {
  const rows = await conn.query(
    `UPDATE $intent SET status = $to, result = $result,
       decided_by = IF decided_by = NONE { fn::current_user() } ELSE { decided_by },
       decided_at = IF decided_at = NONE { time::now() } ELSE { decided_at }
     WHERE status = $from AND fingerprint = $fingerprint RETURN AFTER`,
    { intent: new StringRecordId(intent.id), from, to, result, fingerprint: intent.fingerprint },
  );
  return rows.length === 1;
}

async function requireAbsent(tx: DdlTransactionWriter, change: OfficeDdlChange): Promise<void> {
  const [db] = await tx.query<{ tables: Record<string, string> }>("RETURN [(INFO FOR DB)]");
  const exists = db?.tables?.[change.table];
  if (change.op === "define_table") {
    if (exists) throw new Error("业务表已存在；本请求不会覆盖已有结构");
    return;
  }
  if (!exists) throw new Error("目标业务表不存在");
  const [info] = await tx.query<{ fields: Record<string, string>; indexes: Record<string, string> }>(`RETURN [(INFO FOR TABLE ${change.table})]`);
  if (change.op === "define_field") {
    if (info?.fields?.[change.field]) throw new Error("字段已存在；本请求不会改写类型");
  } else {
    if (info?.indexes?.[change.index]) throw new Error("索引已存在；本请求不会覆盖索引");
    if (change.fields.some((field) => !info?.fields?.[field])) throw new Error("索引字段必须已定义");
  }
}

export async function decideOfficeDdl(conn: DdlConnection, id: string, decision: "approve" | "reject"): Promise<OfficeDdlIntent> {
  let intent = await readOfficeDdl(conn, id);
  if (DDL_TERMINAL.has(intent.status)) return intent;
  if (decision === "reject") {
    if (intent.status === "requested" || intent.status === "approved") {
      if (!await transition(conn, intent, intent.status, "rejected", { outcome: "rejected", message: "管理员拒绝结构变更" })) {
        throw new Error("请求已由其他会话处理，或当前会话无管理员权限");
      }
    }
    return readOfficeDdl(conn, id);
  }
  if (intent.status === "requested") {
    if (!await transition(conn, intent, "requested", "approved", { outcome: "approved", message: "管理员确认所显示的变更" })) {
      throw new Error("请求已由其他会话处理，或当前会话无管理员权限");
    }
    intent = await readOfficeDdl(conn, id);
  }
  if (intent.status !== "approved") return intent; // executing/ambiguous 绝不重放 DDL。
  if (!await transition(conn, intent, "approved", "executing", { outcome: "executing", message: "等待数据库事务提交" })) {
    return readOfficeDdl(conn, id);
  }
  try {
    await conn.transaction(async (tx) => {
      // 锁定同一持久状态；另一个标签页已核对未知结果时，不允许迟到执行。
      const claimed = await tx.query("UPDATE $intent SET result = $result WHERE status = 'executing' RETURN AFTER", {
        intent: new StringRecordId(id), result: { outcome: "executing", message: "数据库事务中" },
      });
      if (claimed.length !== 1) throw new Error("执行状态已变更");
      await requireAbsent(tx, intent.change);
      await tx.query(intent.sql);
      const saved = await tx.query(
        "UPDATE $intent SET status = 'succeeded', result = $result WHERE status = 'executing' RETURN AFTER",
        { intent: new StringRecordId(id), result: { outcome: "succeeded", message: "结构变更及结果已原子提交", fingerprint: intent.fingerprint } },
      );
      if (saved.length !== 1) throw new Error("结果写入失败，取消结构变更");
    });
  } catch (cause) {
    // transaction 保证 DDL 与回执原子性。网络错误仍可能是已提交但响应丢失，先回读。
    const current = await readOfficeDdl(conn, id);
    if (DDL_TERMINAL.has(current.status)) return current;
    const message = cause instanceof Error ? cause.message : String(cause);
    const unknown = /network|socket|disconnect|timeout|closed|connection/i.test(message);
    await transition(conn, current, "executing", unknown ? "ambiguous" : "failed", {
      outcome: unknown ? "ambiguous" : "failed", message,
    });
  }
  return readOfficeDdl(conn, id);
}

/** 刷新/丢响应后只核对持久事务结果；不重试 DDL。竞争事务被状态写冲突取消。 */
export async function reconcileOfficeDdl(conn: DdlConnection, id: string): Promise<OfficeDdlIntent> {
  let intent = await readOfficeDdl(conn, id);
  if (intent.status === "executing") {
    await transition(conn, intent, "executing", "ambiguous", { outcome: "ambiguous", message: "执行会话中断，待核对" });
    intent = await readOfficeDdl(conn, id);
  }
  if (intent.status === "ambiguous") {
    await conn.transaction(async (tx) => {
      await tx.query("UPDATE $intent SET status = 'reconciled', result = $result WHERE status = 'ambiguous' RETURN AFTER", {
        intent: new StringRecordId(id),
        result: { outcome: "failed", message: "未发现已提交成功回执；已封闭旧执行，不重放 DDL", reconciled: true },
      });
    });
  }
  return readOfficeDdl(conn, id);
}
