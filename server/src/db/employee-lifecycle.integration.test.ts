import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { StringRecordId, Surreal } from "surrealdb";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { homedir } from "node:os";
import { createEmployeeLifecycle } from "../../ai/office/employee-lifecycle";
import { createEmployeeRuntime } from "../../ai/office/employee-runtime";

/**
 * VER02 真实库集成测试：自起 --allow-all SurrealDB + 本地 JWKS，完整应用
 * workspace template（含三条生产 access），验证：
 * - 管理员 JWT 会话（$auth=NONE、RL=Owner）写 user 记录幂等创建员工；
 * - root 只写 employee_credential；
 * - employee access 的 SIGNIN 校验 subject+secret+status；
 * - pause/retire 切断 SIGNIN，resume 恢复，retire 旋转凭证。
 */

const opened: Surreal[] = [];
const fixtureCleanup: Array<() => void> = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
  for (const cleanup of fixtureCleanup.splice(0)) cleanup();
});

type Fixture = {
  url: string;
  namespace: string;
  database: string;
  issuer: string;
  privateKey: CryptoKey;
  root: Surreal;
};

async function setupFixture(): Promise<Fixture> {
  const port = 23000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const keys = await generateKeyPair("ES256");
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ keys: [{ ...publicKey, kid: "fixture", alg: "ES256", use: "sig" }] }),
  });
  const issuer = `http://127.0.0.1:${jwks.port}`;
  const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn(
    [binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const namespace = "main";
  const database = "ws_lifecycle";
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
    await root.query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace}; USE NS ${namespace}; DEFINE DATABASE IF NOT EXISTS ${database}; USE DB ${database};`);
    await root.use({ namespace, database });
    for (const script of await loadTemplateScripts({ oidcJwksUrl: `${issuer}/jwks` })) {
      await root.query(script.sql).collect();
    }
    // 模板 001 的 admin AUTHENTICATE 在"首次建用户"的 IF 块里把 CREATE 的记录
    // 当成块值返回，3.2.3 本地引擎会因此拒掉当次 authenticate（第二次即放行）。
    // 预建管理员记录绕开这个一次性边角，让测试聚焦生命周期本身。
    await root.query(`CREATE user:owner CONTENT {
      subject: "owner-sub", email: "owner@example.test", display_name: "owner@example.test",
      kind: "human", is_admin: true, last_seen_at: time::now()
    };`);
    fixtureCleanup.push(() => { proc.kill(); jwks.stop(true); });
    return { url, namespace, database, issuer, privateKey: keys.privateKey, root };
  } catch (cause) {
    proc.kill();
    jwks.stop(true);
    throw cause;
  }
}

async function jwtSession(fixture: Fixture, input: { sub: string; ac: "admin" | "participant" }): Promise<Surreal> {
  const token = await new SignJWT({
    ns: fixture.namespace,
    db: fixture.database,
    ac: input.ac,
    RL: input.ac === "admin" ? ["Owner"] : ["Editor"],
    email: `${input.sub}@example.test`,
  })
    .setSubject(input.sub)
    .setIssuer(fixture.issuer)
    .setExpirationTime("120s")
    .setIssuedAt()
    .setProtectedHeader({ alg: "ES256", kid: "fixture" })
    .sign(fixture.privateKey);
  const db = new Surreal();
  opened.push(db);
  await db.connect(fixture.url);
  await db.authenticate(token);
  return db;
}

async function employeeSignin(fixture: Fixture, subject: string, pass: string): Promise<Surreal> {
  const db = new Surreal();
  opened.push(db);
  await db.connect(fixture.url, { namespace: fixture.namespace, database: fixture.database });
  await db.signin({
    namespace: fixture.namespace,
    database: fixture.database,
    access: "employee",
    variables: { subject, pass },
  });
  return db;
}

async function readSecret(fixture: Fixture, employeeId: string): Promise<string | null> {
  const [rows] = await fixture.root.query<[{ secret?: unknown }[]]>(
    "SELECT secret FROM employee_credential WHERE employee = $employee LIMIT 1;",
    { employee: new StringRecordId(employeeId) },
  );
  return typeof rows?.[0]?.secret === "string" ? rows[0].secret : null;
}

describe("employee lifecycle against real SurrealDB", () => {
  test("create→pause→resume→retire 全程：幂等、SIGNIN 门控、凭证旋转", async () => {
    const fixture = await setupFixture();
    const disconnected = new Set<Surreal>();
    const runtime = createEmployeeRuntime({
      connect: () => {
        const db = new Surreal();
        db.subscribe("disconnected", () => { disconnected.add(db); });
        return db;
      },
      surrealUrl: fixture.url,
      namespace: fixture.namespace,
    });
    const lifecycle = createEmployeeLifecycle({
      resolveWorkspace: async () => ({ dbName: fixture.database }),
      callerSession: async (_db, token) => {
        // token 在此 fixture 里语义化为 subject；真实路由传 OIDC rawToken，
        // createCallerSession 会 authenticate 到 token 声明的 db。
        const db = new Surreal();
        opened.push(db);
        await db.connect(fixture.url);
        const jwt = await new SignJWT({
          ns: fixture.namespace, db: fixture.database, ac: "admin", RL: ["Owner"],
          email: `${token}@example.test`,
        })
          .setSubject(token)
          .setIssuer(fixture.issuer)
          .setExpirationTime("120s")
          .setProtectedHeader({ alg: "ES256", kid: "fixture" })
          .sign(fixture.privateKey);
        await db.authenticate(jwt);
        return db;
      },
      rootSession: async () => fixture.root,
      runtime,
      sessionTtlSeconds: 3600,
    });
    // 回归（VER02 QA 退回根因）：无 roleKey 创建不得把 JS null 绑进 option 字段——
    // 引擎把 null 当 NULL 而非 NONE，option<record<…>> 类型强转会直接拒收。
    const noRole = await lifecycle.provision({ slug: "acme", callerToken: "owner-sub", requestKey: "req-key-0000" });
    expect(noRole.kind).toBe("ok");
    if (noRole.kind === "ok") {
      expect(noRole.employee.status).toBe("active");
      expect(noRole.employee.roleKey).toBeNull();
    }

    const input = { slug: "acme", callerToken: "owner-sub", requestKey: "req-key-0001", roleKey: "project-manager" };

    // 幂等创建：两次调用收敛到同一员工、同一条凭证
    const first = await lifecycle.provision(input);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    expect(first.created).toBe(true);
    expect(first.employee.status).toBe("active");
    const employeeId = first.employee.id;
    const observation = await runtime.inspect(fixture.database, employeeId);
    expect(observation).toMatchObject({ usable: true, sessionPresent: true, generation: 1 });
    const secret = await readSecret(fixture, employeeId);
    expect(secret).toBeTruthy();

    const again = await lifecycle.provision(input);
    expect(again.kind).toBe("ok");
    if (again.kind !== "ok") return;
    expect(again.employee.id).toBe(employeeId);
    const [userCount] = await fixture.root.query<[{ n: number }[]]>(
      `SELECT count() AS n FROM user WHERE kind = "virtual" AND subject = $subject GROUP ALL;`,
      { subject: first.employee.subject },
    );
    expect(userCount?.[0]?.n).toBe(1);
    const [credCount] = await fixture.root.query<[{ n: number }[]]>(
      "SELECT count() AS n FROM employee_credential WHERE employee = $employee GROUP ALL;",
      { employee: new StringRecordId(employeeId) },
    );
    expect(credCount?.[0]?.n).toBe(1);

    // active 员工可 SIGNIN 且被归因；也能读岗位键
    const employee = await employeeSignin(fixture, first.employee.subject, secret!);
    const [who] = await employee.query<[{ id?: unknown; role?: unknown }[]]>(
      "SELECT id, virtual_profile.role_key AS role FROM user WHERE id = $auth.id;",
    );
    expect(String(who?.[0]?.id ?? "")).toBe(employeeId);
    expect(who?.[0]?.role).toBe("project-manager");

    const originalSession = runtime.session(fixture.database, employeeId)!;
    expect(disconnected.has(originalSession)).toBe(false);
    // pause：关闭 runtime 会话，DB 层 SIGNIN 同步拒绝
    expect((await lifecycle.pause("acme", employeeId.slice(5), "owner-sub")).kind).toBe("ok");
    expect(runtime.session(fixture.database, employeeId)).toBeUndefined();
    expect(await runtime.inspect(fixture.database, employeeId)).toMatchObject({ usable: false, closeConfirmed: true });
    expect(disconnected.has(originalSession)).toBe(true);
    expect(originalSession.status).toBe("disconnected");
    await expect(runtime.openSession(fixture.database, employeeId)).rejects.toThrow("employee-session-blocked");
    await expect(employeeSignin(fixture, first.employee.subject, secret!)).rejects.toThrow();

    // resume：恢复后可再次 SIGNIN
    expect((await lifecycle.resume("acme", employeeId.slice(5), "owner-sub")).kind).toBe("ok");
    expect(await runtime.inspect(fixture.database, employeeId)).toMatchObject({ usable: true, generation: 3, instanceId: observation.instanceId });
    const resumedSession = runtime.session(fixture.database, employeeId)!;
    const revived = await employeeSignin(fixture, first.employee.subject, secret!);
    expect(revived).toBeDefined();

    // retire：旋转凭证 + 记录剩余窗口；旧 secret 与 retired 状态双重拒绝
    const retired = await lifecycle.retire("acme", employeeId.slice(5), "owner-sub");
    expect(retired.kind).toBe("ok");
    if (retired.kind !== "ok") return;
    expect(retired.credentialsExpireBy).toBeTruthy();
    expect(await runtime.inspect(fixture.database, employeeId)).toMatchObject({ usable: false, closeConfirmed: true });
    expect(disconnected.has(resumedSession)).toBe(true);
    expect(resumedSession.status).toBe("disconnected");
    const rotated = await readSecret(fixture, employeeId);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(secret);
    await expect(employeeSignin(fixture, first.employee.subject, secret!)).rejects.toThrow();
    await expect(employeeSignin(fixture, first.employee.subject, rotated!)).rejects.toThrow();

    // 重放 retire 幂等；resume 已退休员工被拒
    expect((await lifecycle.retire("acme", employeeId.slice(5), "owner-sub")).kind).toBe("ok");
    expect((await lifecycle.resume("acme", employeeId.slice(5), "owner-sub")).kind).toBe("invalid-transition");

    await runtime.stop();
  }, 60_000);

  test("participant RECORD 会话不能写 user 记录（DB 引擎硬拒）", async () => {
    const fixture = await setupFixture();
    const member = await jwtSession(fixture, { sub: "member-sub", ac: "participant" });
    const employee = new StringRecordId("user:ve_intruder");
    const [created] = await member.query<unknown[]>(
      `CREATE $target CONTENT { email: "x@x", subject: "x", kind: "virtual", is_admin: false };`,
      { target: employee },
    );
    expect(created).toEqual([]);
  }, 60_000);
});
