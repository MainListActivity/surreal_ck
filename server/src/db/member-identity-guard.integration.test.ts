import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { StringRecordId, Surreal } from "surrealdb";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { homedir } from "node:os";

/**
 * 061 防护回归：loopback 内存数据库、本地 JWKS、完整模板 001–061。
 * 覆盖身份字段冻结、展示更新、停用后的旧会话和重新认证，
 * 以及 JWT Owner 维护和 PM 创建/激活自有 analyst 的合法路径。
 * root 仅加载 schema、准备/变更 fixture 与核验持久值。
 * 不覆盖 pause/resume/retire、凭据旋转或全库会话撤销。
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
      if (script.version > 61) continue;
      await root.query(script.sql).collect();
    }
    // 预建控制面维护用的 owner fixture；首次认证创建由独立用例验证。
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

// 只验证已知自身字段漏洞的防护，不测试跨用户越权、DDL 升级或索引复活。
describe("061 member identity defensive regression", () => {
  test("首次 participant 认证创建合法成员", async () => {
    const f = await setupFixture();
    const db = await jwtSession(f, { sub: "first-participant", ac: "participant" });
    const [rows] = await db.query<[{subject: string; kind: string; is_admin: boolean}[]]>(
      "SELECT subject, kind, is_admin FROM user WHERE subject='first-participant';",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({subject:"first-participant",kind:"human",is_admin:false});
  }, 30000);

  test("首次 admin 认证创建合法管理员", async () => {
    const f = await setupFixture();
    const db = await jwtSession(f, { sub: "first-admin", ac: "admin" });
    const [rows] = await db.query<[{subject: string; kind: string; is_admin: boolean}[]]>(
      "SELECT subject, kind, is_admin FROM user WHERE subject='first-admin';",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({subject:"first-admin",kind:"human",is_admin:true});
  }, 30000);

  test("自身身份字段拒绝，展示更新保留，停用后旧会话及重新认证拒绝", async () => {
    const f = await setupFixture();
    const db = await jwtSession(f, { sub: "member-sub", ac: "participant" });
    const [ids] = await db.query<[string[]]>("SELECT VALUE <string>id FROM user WHERE subject = 'member-sub';");
    const id = new StringRecordId(ids[0]!);
    for (const field of ["subject", "email", "kind", "is_admin", "disabled_at"]) {
      const value = field === "is_admin" ? "true" : field === "disabled_at" ? "time::now()" : field === "kind" ? "'virtual'" : "'changed'";
      await db.query(`UPDATE $id SET ${field} = ${value};`, { id }).collect().catch(() => undefined);
      const [unchanged] = await db.query<[Record<string, unknown>[]]>("SELECT * FROM $id;", { id });
      const expected: Record<string, unknown> = { subject: "member-sub", email: "member-sub@example.test", kind: "human", is_admin: false };
      expect(unchanged[0]?.[field]).toEqual(expected[field]);
    }
    for (const query of [
      "UPDATE $id MERGE {is_admin:true,subject:'changed',virtual_profile:{role_key:'project-manager',role:office_role:data_analyst,supervisor:$id,status:'active'}};",
      "UPDATE $id PATCH [{op:'replace',path:'/is_admin',value:true}];",
      "UPDATE $id CONTENT {email:'changed',subject:'changed',kind:'virtual',is_admin:true,display_name:'profile-only'};",
    ]) {
      await db.query(query, { id }).collect().catch(() => undefined);
      const [rows] = await db.query<[Record<string, unknown>[]]>("SELECT subject,email,kind,is_admin,virtual_profile FROM $id;", { id });
      expect(rows[0]?.subject).toBe("member-sub");
      expect(rows[0]?.email).toBe("member-sub@example.test");
      expect(rows[0]?.kind).toBe("human");
      expect(rows[0]?.is_admin).toBe(false);
      expect(rows[0]?.virtual_profile).toBeUndefined();
    }
    await db.query("UPDATE $id SET display_name = 'Allowed', avatar = 'local-avatar';", { id }).collect();
    const [profile] = await db.query<[{ display_name: string }[]]>("SELECT display_name FROM $id;", { id });
    expect(profile[0]?.display_name).toBe("Allowed");
    await f.root.query("UPDATE $id SET disabled_at = time::now();", { id }).collect();
    await db.query("UPDATE $id UNSET disabled_at;", { id }).collect().catch(() => undefined);
    await db.query("UPDATE $id SET is_admin=true;", { id }).collect().catch(() => undefined);
    await db.query("UPDATE $id SET display_name = 'Disabled change';", { id }).collect().catch(() => undefined);
    const [after] = await f.root.query<[{ disabled_at?: unknown; display_name: string; is_admin: boolean }[]]>("SELECT disabled_at, display_name, is_admin FROM $id;", { id });
    expect(after[0]?.disabled_at).toBeDefined();
    expect(after[0]?.display_name).toBe("Allowed");
    expect(after[0]?.is_admin).toBe(false);
    await expect(jwtSession(f, { sub: "member-sub", ac: "participant" })).rejects.toThrow();
  }, 30000);

  test("JWT Owner、控制面及PM自有analyst创建激活保持正常", async () => {
    const f = await setupFixture();
    const admin = await jwtSession(f, { sub: "owner-sub", ac: "admin" });
    await admin.query(`CREATE user:managed CONTENT {subject:'managed-sub',email:'managed@example.test',kind:'human',is_admin:false};
      UPDATE user:managed SET is_admin=true;
      UPDATE user:managed SET is_admin=false,disabled_at=time::now();`).collect();
    await f.root.query("UPDATE user:managed UNSET disabled_at;").collect();
    const [managed] = await admin.query<[{ is_admin: boolean; disabled_at?: unknown }[]]>("SELECT is_admin,disabled_at FROM user:managed;");
    expect(managed[0]?.is_admin).toBe(false);
    expect(managed[0]?.disabled_at).toBeUndefined();
    const secret = crypto.randomUUID();
    await f.root.query(`CREATE user:pm CONTENT {subject:'urn:virtual:pm',email:'pm@example.test',kind:'virtual',is_admin:false,
      virtual_profile:{role_key:'project-manager',status:'active'}};
      CREATE employee_credential:pm SET employee=user:pm,secret=$secret;`, { secret }).collect();
    const pm = await employeeSignin(f, "urn:virtual:pm", secret);
    await expect(pm.query("UPDATE user:pm SET virtual_profile.status='paused';").collect()).rejects.toThrow();
    const [pmRows] = await pm.query<[{ virtual_profile: { status: string } }[]]>("SELECT virtual_profile FROM user:pm;");
    expect(pmRows[0]?.virtual_profile.status).toBe("active");
    await pm.query(`CREATE user:analyst CONTENT {subject:'urn:virtual:analyst',email:'analyst@example.test',kind:'virtual',is_admin:false,
      virtual_profile:{role_key:'data-analyst',role:office_role:data_analyst,supervisor:user:pm}};
      UPDATE user:analyst SET virtual_profile.status='active',virtual_profile.last_active_at=time::now();`).collect();
    const [analyst] = await pm.query<[{ virtual_profile: { status: string } }[]]>("SELECT virtual_profile FROM user:analyst;");
    expect(analyst[0]?.virtual_profile.status).toBe("active");
    await f.root.query("UPDATE user:pm SET disabled_at=time::now();").collect();
    await expect(employeeSignin(f, "urn:virtual:pm", secret)).rejects.toThrow();
    await f.root.query("UPDATE user:owner SET disabled_at=time::now();").collect();
    await expect(jwtSession(f, {sub:"owner-sub",ac:"admin"})).rejects.toThrow();
  }, 30000);
});
