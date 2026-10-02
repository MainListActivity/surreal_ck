import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";
import { homedir } from "node:os";
import {
  loadRiskNotifications,
  resolveOfficeRequest,
  resolveRiskNotification,
  watchNotificationInbox,
} from "./risk-notifications";
import { createBrowserConn, type SurrealConn } from "./surreal";

/**
 * VO03/AC8 收件箱断线重连（真实 SurrealDB fork + 真实 WebSocket 中断）：
 * 员工请求经同一 user_notification 收件箱到达 participant 会话；连接被强制
 * 切断后 SDK 自动重连并恢复会话。观测点：
 * - managed live 订阅在重连后自动重注册——重连后的新变更仍然推送；
 * - 但断开窗口内的变更不会补推——必须由 connected 后补快照收敛；
 * - 重连后 participant 身份恢复：请求终态 CAS 与债权提醒老路径都可用。
 */

const opened: Surreal[] = [];
const fixtureCleanup: Array<() => void> = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
  for (const cleanup of fixtureCleanup.splice(0)) cleanup();
});

/** 断线原语：真实关闭底层 WebSocket（服务端仍在运行），SDK 走断线→自动重连路径。 */
class CuttableSocket extends WebSocket {
  static #open = new Set<CuttableSocket>();

  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    CuttableSocket.#open.add(this);
    this.addEventListener("close", () => CuttableSocket.#open.delete(this));
  }

  static severAll(): void {
    for (const socket of [...CuttableSocket.#open]) socket.close();
  }
}

const FAST_RECONNECT = {
  reconnect: {
    enabled: true,
    attempts: -1,
    retryDelay: 40,
    retryDelayMax: 300,
    retryDelayMultiplier: 1,
    retryDelayJitter: 0,
  },
};

type Fixture = {
  url: string;
  namespace: string;
  database: string;
  issuer: string;
  privateKey: CryptoKey;
  root: Surreal;
};

function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 与 server fixture 等价的 ES256 JWT，零依赖版（WebCrypto 签名）。 */
async function jwt(fixture: Fixture, sub: string, ac: "admin" | "participant"): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: "fixture", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: fixture.issuer,
    sub,
    ns: fixture.namespace,
    db: fixture.database,
    ac,
    email: `${sub}@example.test`,
    iat: now,
    exp: now + 120,
  };
  if (ac === "admin") claims.RL = ["Owner"];
  const payload = base64url(JSON.stringify(claims));
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    fixture.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  ));
  return `${header}.${payload}.${base64url(signature)}`;
}

async function setupFixture(database: string): Promise<Fixture> {
  const port = 23000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey))
    .toString("base64");
  const publicKey =
    `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;
  const issuer = "https://vo03-web-fixture.example.test";
  const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn(
    [binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const namespace = "main";
  const root = new Surreal();
  opened.push(root);
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* startup */ }
      await Bun.sleep(50);
    }
    const url = `ws://127.0.0.1:${port}/rpc`;
    await root.connect(url);
    await root.signin({ username: "test", password });
    await root.query(
      `DEFINE NAMESPACE IF NOT EXISTS ${namespace}; USE NS ${namespace}; DEFINE DATABASE IF NOT EXISTS ${database}; USE DB ${database};`,
    ).collect();
    await root.use({ namespace, database });
    for (const script of await loadTemplateScripts({ oidcJwksUrl: `${issuer}/jwks` })) {
      // 本地 fork 可能未启用 jwks feature；只替换签名验证来源，保留生产 access 定义。
      const sql = script.sql.replaceAll(
        `JWT URL "${issuer}/jwks"`,
        `JWT ALGORITHM ES256 KEY ${JSON.stringify(publicKey)}`,
      );
      await root.query(sql).collect();
    }
    await root.query(`
      CREATE user:owner CONTENT {
        subject: "owner-sub", email: "owner@example.test", display_name: "Owner",
        kind: "human", is_admin: true
      };
      CREATE user:member CONTENT {
        subject: "member-sub", email: "member@example.test", display_name: "Member",
        kind: "human", is_admin: false
      };
      CREATE user:ve_pm CONTENT {
        subject: "ve-pm", email: "pm@virtual.test", display_name: "项目经理",
        kind: "virtual", virtual_profile: { status: "active" }
      };
    `).collect();
    fixtureCleanup.push(() => { proc.kill(); });
    return { url, namespace, database, issuer, privateKey: keys.privateKey, root };
  } catch (cause) {
    proc.kill();
    throw cause;
  }
}

/** 经可断开的真实 WebSocket 建立的 participant 浏览器连接。 */
async function memberConn(fixture: Fixture): Promise<SurrealConn> {
  const raw = new Surreal({ websocketImpl: CuttableSocket });
  opened.push(raw);
  const conn = createBrowserConn(raw as never);
  await conn.connect(fixture.url, FAST_RECONNECT);
  await conn.authenticate(await jwt(fixture, "member-sub", "participant"));
  return conn;
}

/** admin JWT 会话：office_task 的 assigner 依赖 fn::current_user()，root 为 NONE。 */
async function adminConn(fixture: Fixture): Promise<Surreal> {
  const db = new Surreal();
  opened.push(db);
  await db.connect(fixture.url);
  await db.authenticate(await jwt(fixture, "owner-sub", "admin"));
  return db;
}

/** 等 SDK 完成一次断线重连；必须在切断前调用，拿到下一次 connected 的 promise。 */
function waitForReconnect(conn: SurrealConn): () => Promise<void> {
  let resolveNext!: () => void;
  const next = new Promise<void>((resolve) => {
    resolveNext = resolve;
  });
  const off = conn.subscribe("connected", () => {
    off();
    resolveNext();
  });
  return () => next;
}

async function waitFor<T>(
  fn: () => Promise<T | null | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | false = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last != null && last !== false) return last;
    await Bun.sleep(60);
  }
  throw new Error("waitFor 超时：" + JSON.stringify(last));
}

describe("VO03 收件箱断线重连（真实 fork + 真实 WS 中断）", () => {
  test("断线窗口变更不补推、connected 补快照收敛；重连后 LIVE 恢复且 participant 可解决请求与债权提醒", async () => {
    const fixture = await setupFixture("ws_vo03_web_reconnect");
    const member = await memberConn(fixture);
    const admin = await adminConn(fixture);

    // 员工发问 + 既有债权提醒：同一收件箱视图。office_task.assigner 依赖
    // fn::current_user()，必须经 admin 会话创建；通知由 root 写入（等价虚拟
    // 员工会话的落库结果，本测试不覆盖员工写入路径——server 纵切已覆盖）。
    await admin.query(`
      CREATE office_task:web_ask CONTENT { goal: "断线期间的请求", assignee: user:ve_pm };
    `).collect();
    await fixture.root.query(`
      CREATE user_notification:req_ask CONTENT {
        dedupe_key: "web-req-ask", to_user: user:member, from_employee: user:ve_pm,
        purpose: "office-request", title: "按哪笔债权为准？", body: "金额一致日期不同",
        severity: "warning", task: office_task:web_ask,
        payload: { prompt: "按哪笔为准？", question_type: "free-text" }
      };
      CREATE user_notification:risk_keep CONTENT {
        dedupe_key: "web-risk-keep", to_user: user:member, from_employee: user:ve_pm,
        purpose: "claims-risk", title: "材料缺失", body: "缺少签收单", severity: "warning"
      };
    `).collect();

    // 收件箱快照 + 与组件一致的数据通道（LIVE + connected 补快照）。
    let latest = await loadRiskNotifications(member);
    expect(latest.map((n) => n.id)).toContain("user_notification:req_ask");
    expect(latest.map((n) => n.id)).toContain("user_notification:risk_keep");
    let refreshCount = 0;
    const unwatch = watchNotificationInbox(member, () => {
      refreshCount += 1;
      void loadRiskNotifications(member).then((rows) => {
        latest = rows;
      });
    });
    // 独立观测原始 LIVE 流：区分"断线窗口是否被重放"与"重连后是否恢复"。
    const liveIds: string[] = [];
    await member.liveTable("user_notification", (msg) => {
      liveIds.push(`${msg.action}:${String(msg.value?.id ?? "")}`);
    });

    // 基线：断线前的变更经 LIVE 推送并触发刷新。
    await fixture.root.query(`CREATE user_notification:req_baseline CONTENT {
      dedupe_key: "web-req-baseline", to_user: user:member, from_employee: user:ve_pm,
      purpose: "office-request", title: "基线请求", body: "断线前",
      severity: "warning", task: office_task:web_ask,
      payload: { prompt: "基线", question_type: "free-text" }
    };`).collect();
    await waitFor(async () =>
      liveIds.includes("CREATE:user_notification:req_baseline") ? true : null);
    await waitFor(async () =>
      latest.some((n) => n.id === "user_notification:req_baseline") ? true : null);

    // 断线：切断底层 WS；断开窗口内由其他会话写入新请求——该变更不会补推。
    const reconnected = waitForReconnect(member);
    CuttableSocket.severAll();
    await fixture.root.query(`CREATE user_notification:req_gap CONTENT {
      dedupe_key: "web-req-gap", to_user: user:member, from_employee: user:ve_pm,
      purpose: "office-request", title: "断线窗口请求", body: "断线期间创建",
      severity: "warning", task: office_task:web_ask,
      payload: { prompt: "窗口内", question_type: "free-text" }
    };`).collect();
    await reconnected();

    // 观测 1：LIVE 不重放断线窗口的 req_gap（给一小段窗口确认没有推送到达）。
    await Bun.sleep(400);
    expect(liveIds.includes("CREATE:user_notification:req_gap")).toBe(false);
    // 观测 2：connected 触发的补快照让收件箱收敛到数据库真相。
    await waitFor(async () =>
      latest.some((n) => n.id === "user_notification:req_gap") ? true : null);
    const refreshesAfterReconnect = refreshCount;

    // 观测 3：重连后 LIVE 已重注册——新变更照常推送。
    await fixture.root.query(`CREATE user_notification:req_after CONTENT {
      dedupe_key: "web-req-after", to_user: user:member, from_employee: user:ve_pm,
      purpose: "office-request", title: "重连后请求", body: "重连后创建",
      severity: "warning", task: office_task:web_ask,
      payload: { prompt: "重连后", question_type: "free-text" }
    };`).collect();
    await waitFor(async () =>
      liveIds.includes("CREATE:user_notification:req_after") ? true : null);
    await waitFor(async () => refreshCount > refreshesAfterReconnect ? true : null);

    // 观测 4：重连后 participant 身份恢复——请求 CAS 终态与债权提醒老路径可用。
    const resolved = await resolveOfficeRequest(member, "user_notification:req_ask", {
      action: "answered",
      text: "以先到期的为准",
    });
    expect(resolved.status).toBe("resolved");
    const again = await resolveOfficeRequest(member, "user_notification:req_ask", {
      action: "rejected",
      text: "改口",
    });
    expect(again).toMatchObject({ status: "already-resolved", answerAction: "answered" });
    await resolveRiskNotification(member, "user_notification:risk_keep", "已补齐材料");
    latest = await loadRiskNotifications(member);
    const askRow = latest.find((n) => n.id === "user_notification:req_ask");
    expect(askRow?.answerAction).toBe("answered");
    expect(askRow?.answerText).toBe("以先到期的为准");
    // claims-risk 终态行不再出现在收件箱快照。
    expect(latest.some((n) => n.id === "user_notification:risk_keep")).toBe(false);

    unwatch();
  }, 60_000);
});
