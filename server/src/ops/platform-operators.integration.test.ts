import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { Surreal } from "surrealdb";
import { ensureSystemSchema } from "../db/system-schema";
import { createOpsPlatformOperatorsRoutes } from "../routes/ops-platform-operators";
import { SurrealPlatformOperatorList, platformOperatorSubjectHash } from "./platform-operators";

const enabled = process.env.RUN_LOCAL_SURREALDB_PLATFORM_OPERATOR_LIST_TESTS === "1";
const localTest = test.skipIf(!enabled);
const surrealBinary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;

const CURRENT = "26dba3a6-4392-4840-a856-264d6f07fbee";
const SECOND = "8a41f4e7-41db-4784-a5e9-28b061124647";
const THIRD = "11111111-2222-3333-4444-555555555555";

let endpoint = "";
let processHandle: ReturnType<typeof Bun.spawn> | null = null;
const sessions: Surreal[] = [];

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolve(address.port));
    });
  });
}

async function session(database: string, namespace = "main"): Promise<Surreal> {
  const db = new Surreal();
  await db.connect(`${endpoint}/rpc`);
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace, database });
  sessions.push(db);
  return db;
}

/** 只读快照：用来证明调用前后 _system 里一个字都没变。 */
async function fingerprint(root: Surreal): Promise<string> {
  const [operators, capabilities] = await root.query(
    `SELECT id, subject, kind, status FROM platform_operator ORDER BY id;
     SELECT id, operator, capability, status FROM platform_operator_capability ORDER BY id;`,
  ) as unknown[][];
  return JSON.stringify({ operators, capabilities });
}

beforeAll(async () => {
  if (!enabled) return;
  const port = await freePort();
  endpoint = `ws://127.0.0.1:${port}`;
  processHandle = Bun.spawn(
    [surrealBinary, "start", "--no-banner", "--log", "none", "--bind", `127.0.0.1:${port}`,
      "--user", "root", "--pass", "root", "memory"],
    { stdout: "ignore", stderr: "ignore" },
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const ready = Bun.spawn([surrealBinary, "is-ready", "--endpoint", endpoint],
      { stdout: "ignore", stderr: "ignore" });
    if (await ready.exited === 0) break;
    await Bun.sleep(100);
  }
  const root = await session("_system");
  await ensureSystemSchema(root, { namespace: "main" });
  await root.query(`
    CREATE platform_operator:current SET subject = $current, kind = "human", status = "active";
    CREATE platform_operator:second SET subject = $second, status = "active";
    CREATE platform_operator:third SET subject = $third, kind = "agent", status = "disabled";
    CREATE platform_operator_capability:current_quota SET operator = platform_operator:current, capability = "quota.read", status = "active", granted_by_subject = "fixture";
    CREATE platform_operator_capability:current_sub SET operator = platform_operator:current, capability = "subscription.manage", status = "active", granted_by_subject = "fixture";
    CREATE platform_operator_capability:second_quota SET operator = platform_operator:second, capability = "quota.read", status = "active", granted_by_subject = "fixture";
    CREATE platform_operator_capability:second_revoked SET operator = platform_operator:second, capability = "override.manage", status = "revoked", granted_by_subject = "fixture";
    CREATE platform_operator_capability:third_quota SET operator = platform_operator:third, capability = "quota.read", status = "active", granted_by_subject = "fixture";
  `, { current: CURRENT, second: SECOND, third: THIRD }).collect();
});

afterAll(async () => {
  await Promise.all(sessions.map((db) => db.close()));
  processHandle?.kill();
  if (processHandle) await processHandle.exited;
});

describe("platform operator list（真实 fork SurrealDB）", () => {
  localTest("列出全部主体、按主体聚合 active 能力并排除 revoked", async () => {
    const reader = new SurrealPlatformOperatorList(
      async (database, namespace) => await session(database, namespace),
      "main",
    );
    const entries = await reader.list();
    const bySubject = new Map(entries.map((entry) => [entry.subject, entry]));

    expect([...bySubject.keys()].sort()).toEqual([CURRENT, SECOND, THIRD].sort());
    expect(bySubject.get(CURRENT)).toMatchObject({
      kind: "human", status: "active", capabilities: ["quota.read", "subscription.manage"],
    });
    // 第二个主体没显式写 kind，schema 默认 human（018-ops-proposals.surql:12），
    // 且 revoked 的 override.manage 不得出现。
    expect(bySubject.get(SECOND)).toMatchObject({ kind: "human", status: "active", capabilities: ["quota.read"] });
    // disabled 主体照样列出（可见性是本接口的价值之一）。
    expect(bySubject.get(THIRD)).toMatchObject({ kind: "agent", status: "disabled", capabilities: ["quota.read"] });
  });

  localTest("路由端到端：返回 3 个主体、只标当前主体、响应不含原始 subject", async () => {
    const reader = new SurrealPlatformOperatorList(
      async (database, namespace) => await session(database, namespace),
      "main",
    );
    const audits: Array<{ operatorCount: number }> = [];
    const app = createOpsPlatformOperatorsRoutes({
      list: reader,
      requireOperator: () => async (c, next) => {
        c.set("platformOperator", { subject: CURRENT, capabilities: ["quota.read"] });
        await next();
      },
      audit: (entry) => audits.push(entry),
    });

    const res = await app.request("/api/ops/platform-operators");
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      format_version: number;
      operators: Array<{ subject_hash: string; isCurrent: boolean; status: string }>;
    };
    expect(body.format_version).toBe(1);
    expect(body.operators).toHaveLength(3);
    expect(body.operators.filter((entry) => entry.isCurrent)).toHaveLength(1);
    expect(body.operators.find((entry) => entry.isCurrent)!.subject_hash)
      .toBe(platformOperatorSubjectHash(CURRENT));
    expect(raw).not.toContain(CURRENT);
    expect(raw).not.toContain(SECOND);
    expect(audits).toEqual([{ event: "platform-operators.list", actorHash: platformOperatorSubjectHash(CURRENT), operatorCount: 3 }]);
  });

  localTest("只读：调用前后 _system 的 platform_operator / capability 完全不变", async () => {
    const root = sessions[0]!;
    const before = await fingerprint(root);
    const reader = new SurrealPlatformOperatorList(
      async (database, namespace) => await session(database, namespace),
      "main",
    );
    await reader.list();
    const app = createOpsPlatformOperatorsRoutes({
      list: reader,
      requireOperator: () => async (c, next) => {
        c.set("platformOperator", { subject: CURRENT, capabilities: ["quota.read"] });
        await next();
      },
      audit: () => {},
    });
    await app.request("/api/ops/platform-operators");
    const after = await fingerprint(root);
    expect(after).toBe(before);
  });
});
