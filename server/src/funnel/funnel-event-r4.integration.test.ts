import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import {
  claimSuspendDecision,
  consumeSuspendAndWrite,
  registerSuspendFence,
  releaseSuspendDecision,
} from "../ai/write-fence";

/**
 * 返工 R4（任务 38ccb7d6）：漏斗埋点修复的真机集成测试。
 *
 * 用全量工作区模板（当前最新版本）在本地公司 fork 实例上验证三项修复：
 * 1. first_login 只在真实首次进入工作区时计数：添加成员不计，首次绑定计一次；
 * 2. funnel_event 普通成员会话不能直接 CREATE，事件写入（触发器）不受影响；
 * 3. ai_proposal_adopted：resume 失败回滚后再次确认，同一次确认只计一次。
 * 与其他 .integration 测试同门控（RUN_LOCAL_SURREALDB_TESTS=1）。
 */

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const SURREAL_URL = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const SURREAL_NS = process.env.LOCAL_SURREAL_NS ?? "main";
const ROOT_AUTH = {
  username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
  password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
};

const opened: Surreal[] = [];
const jwksServers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
  for (const server of jwksServers.splice(0)) server.stop(true);
});

/** 用全量工作区模板建一个隔离库（与建库时的脚本序列一致）。 */
async function setupWorkspaceDb(): Promise<{ root: Surreal; database: string }> {
  const database = `funnel_r4_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  // admin / participant 的 JWT 访问定义需要一个 JWKS 地址；本测试不做 JWT 登录，给空 key 集即可。
  const jwks = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [] }) });
  jwksServers.push(jwks);

  const root = new Surreal();
  opened.push(root);
  await root.connect(SURREAL_URL, { authentication: ROOT_AUTH });
  await root.query(
    `DEFINE NAMESPACE IF NOT EXISTS ${SURREAL_NS}; USE NS ${SURREAL_NS}; DEFINE DATABASE IF NOT EXISTS ${database};`,
  ).collect();
  await root.use({ namespace: SURREAL_NS, database });

  const scripts = await loadTemplateScripts({ oidcJwksUrl: `http://127.0.0.1:${jwks.port}/jwks` });
  for (const script of scripts) {
    try {
      await root.query(script.sql).collect();
    } catch (error) {
      throw new Error(`${script.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 测试专用 RECORD 登录入口：$auth 为 user 记录，表权限按普通成员（participant）口径判定。
  // 生产 participant 走 JWT AUTHENTICATE；这里只换登录方式，不换权限判定。
  await root.query(`
    DEFINE ACCESS OVERWRITE funnel_member ON DATABASE TYPE RECORD
      SIGNIN (SELECT * FROM user WHERE subject = $subject AND kind = "human" AND disabled_at = NONE LIMIT 1)
      DURATION FOR SESSION 1h;
    DEFINE TABLE probe_write SCHEMALESS PERMISSIONS FULL;
  `).collect();
  return { root, database };
}

/** 以普通成员身份登录（RECORD 会话）。 */
async function signInMember(database: string, subject: string): Promise<Surreal> {
  const db = new Surreal();
  opened.push(db);
  await db.connect(SURREAL_URL, { namespace: SURREAL_NS, database });
  await db.signin({ namespace: SURREAL_NS, database, access: "funnel_member", variables: { subject } });
  return db;
}

async function countFunnel(root: Surreal, where: string, vars: Record<string, unknown>): Promise<number> {
  const [rows] = await root.query<[unknown[]]>(`SELECT VALUE id FROM funnel_event WHERE ${where};`, vars);
  return rows.length;
}

function countEvent(root: Surreal, event: string): Promise<number> {
  return countFunnel(root, "event = $event", { event });
}

async function countProbe(root: Surreal): Promise<number> {
  const [rows] = await root.query<[unknown[]]>("SELECT VALUE id FROM probe_write;");
  return rows.length;
}

describe("返工 R4 · 漏斗埋点修复（公司 fork 真机）", () => {
  localSurrealTest("first_login：添加成员不计数，首次真实绑定计一次，之后的更新与重新加入不再计", async () => {
    const { root } = await setupWorkspaceDb();

    // 1. 添加成员：member-manager.ts 的 addMember 只 INSERT human user，subject 留 NONE。
    await root.query(
      `INSERT INTO user { email: "member@ws.test", display_name: "member@ws.test", kind: "human", is_admin: false };`,
    ).collect();
    expect(await countEvent(root, "first_login")).toBe(0);

    // 2. 首次登录绑定：workspace-scope.ts 的 Scenario B 按邮箱回填 subject（UPDATE … SET subject）。
    await root.query(`UPDATE user SET subject = "member-subject" WHERE email = "member@ws.test";`).collect();
    expect(await countEvent(root, "first_login")).toBe(1);

    // 3. 之后的更新与重新加入（ON DUPLICATE KEY UPDATE 复用同一行、保留已绑定 subject）不再计。
    await root.query(`
      INSERT INTO user { email: "member@ws.test", display_name: "member@ws.test", kind: "human", is_admin: false }
        ON DUPLICATE KEY UPDATE display_name = "rejoined", disabled_at = NONE;
    `).collect();
    await root.query(`UPDATE user SET display_name = "renamed" WHERE email = "member@ws.test";`).collect();
    expect(await countEvent(root, "first_login")).toBe(1);

    // 4. 虚拟员工带 subject 创建：kind 不是 human，不计。
    await root.query(`CREATE user SET kind = "virtual", subject = "employee-1", email = "bot@ws.test";`).collect();
    expect(await countEvent(root, "first_login")).toBe(1);

    // 5. 首次登录时由认证创建的真人行（001-access.surql / 007-access-claim-rename.surql 的 IF !$existing 分支）：带 subject 创建即计一次。
    await root.query(`CREATE user SET kind = "human", subject = "new-person", email = "new@ws.test";`).collect();
    expect(await countEvent(root, "first_login")).toBe(2);
  }, 60_000);

  localSurrealTest("funnel_event：普通成员会话直接 CREATE 被拒绝，事件写入（触发器）不受影响", async () => {
    const { root, database } = await setupWorkspaceDb();
    await root.query(`CREATE user SET kind = "human", subject = "m1", email = "m1@ws.test";`).collect();
    const member = await signInMember(database, "m1");

    // 普通成员直接写入一行带标记日期的 funnel_event：不论报错还是静默不落行，都不得产生行。
    const direct = await member.query<[unknown[]]>(
      `CREATE funnel_event CONTENT { event: "first_login", day: "1999-12-31" };`,
    ).then(
      (result) => result[0].length,
      () => 0,
    );
    expect(direct).toBe(0);
    expect(await countFunnel(root, "day = $day", { day: "1999-12-31" })).toBe(0);
  }, 60_000);

  localSurrealTest("ai_proposal_adopted：resume 失败回滚后再次确认，同一次确认只计一次", async () => {
    const { root, database } = await setupWorkspaceDb();
    await root.query(`CREATE user SET kind = "human", subject = "m1", email = "m1@ws.test";`).collect();
    const member = await signInMember(database, "m1");
    const runId = "run-r4-rollback";
    const suspendKey = "stage-1:0";
    await registerSuspendFence(member, { runId, suspendKey, kind: "await-write-confirm" });

    // 1. 首次确认：同一事务内消费 + 业务写，计一次。
    await consumeSuspendAndWrite(member, {
      runId,
      suspendKey,
      decision: "write-confirmed",
      runStatus: "suspended",
      work: (tx) => tx.query(`CREATE probe_write SET run_id = $runId;`, { runId }),
    });
    expect(await countEvent(root, "ai_proposal_adopted")).toBe(1);

    // 2. resume 认领后投递失败：releaseSuspendDecision 把 resumed 回滚为 consumed（consumed_by 仍是 write-confirmed）。
    const claim = await claimSuspendDecision(member, {
      runId,
      suspendKey,
      decision: "write-confirmed",
      runStatus: "suspended",
    });
    expect(claim.claimed).toBe(true);
    await releaseSuspendDecision(member, {
      runId,
      suspendKey,
      decision: "write-confirmed",
      prevStatus: claim.prevStatus,
    });

    // 3. 再次确认（resume 重试）：认领成功，不产生新的业务写，也不再计数。
    const retry = await claimSuspendDecision(member, {
      runId,
      suspendKey,
      decision: "write-confirmed",
      runStatus: "suspended",
    });
    expect(retry.claimed).toBe(true);
    expect(await countEvent(root, "ai_proposal_adopted")).toBe(1);
    expect(await countProbe(root)).toBe(1);

    // 4. 已消费的 suspend 不能再走一次确认写：具名拒绝，零写入，也不计数。
    await expect(consumeSuspendAndWrite(member, {
      runId,
      suspendKey,
      decision: "write-confirmed",
      runStatus: "suspended",
      work: (tx) => tx.query(`CREATE probe_write SET run_id = $runId;`, { runId }),
    })).rejects.toThrow();
    expect(await countProbe(root)).toBe(1);
    expect(await countEvent(root, "ai_proposal_adopted")).toBe(1);
  }, 60_000);

  localSurrealTest("ai_proposal_adopted：两次不同 suspend 的确认各计一次（去重不压掉真实确认）", async () => {
    const { root, database } = await setupWorkspaceDb();
    await root.query(`CREATE user SET kind = "human", subject = "m1", email = "m1@ws.test";`).collect();
    const member = await signInMember(database, "m1");
    const runId = "run-r4-two";
    for (const suspendKey of ["stage-1:0", "stage-2:0"]) {
      await registerSuspendFence(member, { runId, suspendKey, kind: "await-write-confirm" });
      await consumeSuspendAndWrite(member, {
        runId,
        suspendKey,
        decision: "write-confirmed",
        runStatus: "suspended",
        work: (tx) => tx.query(`CREATE probe_write SET run_id = $runId;`, { runId }),
      });
    }
    expect(await countEvent(root, "ai_proposal_adopted")).toBe(2);
    expect(await countProbe(root)).toBe(2);
  }, 60_000);

  localSurrealTest("ai_proposal_adopted：业务写失败整笔回滚，不计数；随后的确认成功才计一次", async () => {
    const { root, database } = await setupWorkspaceDb();
    await root.query(`CREATE user SET kind = "human", subject = "m1", email = "m1@ws.test";`).collect();
    const member = await signInMember(database, "m1");
    const runId = "run-r4-fail";
    const suspendKey = "stage-3:0";
    await registerSuspendFence(member, { runId, suspendKey, kind: "await-write-confirm" });

    await expect(consumeSuspendAndWrite(member, {
      runId,
      suspendKey,
      decision: "write-confirmed",
      runStatus: "suspended",
      work: () => Promise.reject(new Error("business write rejected")),
    })).rejects.toThrow("business write rejected");
    expect(await countEvent(root, "ai_proposal_adopted")).toBe(0);

    // 消费随事务回滚撤销：栅栏行仍是 pending，可重试。
    const [fence] = await root.query<[Array<{ status: string }>]>(
      `SELECT status FROM chat_write_fence WHERE run_id = $runId AND suspend_path = $suspendKey;`,
      { runId, suspendKey },
    );
    expect(fence[0]?.status).toBe("pending");

    await consumeSuspendAndWrite(member, {
      runId,
      suspendKey,
      decision: "write-confirmed",
      runStatus: "suspended",
      work: (tx) => tx.query(`CREATE probe_write SET run_id = $runId;`, { runId }),
    });
    expect(await countEvent(root, "ai_proposal_adopted")).toBe(1);
    expect(await countProbe(root)).toBe(1);
  }, 60_000);
});
