import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { StringRecordId, Surreal } from "surrealdb";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { homedir } from "node:os";

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
};

// legal_reference 归因走 fn::current_user()：admin 是 TYPE JWT 会话（$auth=NONE、
// 权限旁路、$token.sub 反查 user.subject），participant 是 RECORD 会话。自起
// --allow-all SurrealDB + 本地 JWKS fixture 复刻生产 admin 形态，覆盖曾因
// `DEFAULT $auth` 在 JWT 会话报 "record<user> but found NONE" 的退回项。
async function setupFixture(): Promise<Fixture> {
  const port = 21000 + Math.floor(Math.random() * 10000);
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
  const namespace = "test";
  const database = "ws_legal_reference";
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
    await root.query(`DEFINE NAMESPACE ${namespace}; USE NS ${namespace}; DEFINE DATABASE ${database}; USE DB ${database};`);
    await root.use({ namespace, database });
    await root.query(`
      DEFINE TABLE user SCHEMAFULL PERMISSIONS FULL;
      DEFINE FIELD email ON TABLE user TYPE string;
      DEFINE FIELD password ON TABLE user TYPE option<string>;
      DEFINE FIELD subject ON TABLE user TYPE option<string>;
      DEFINE FIELD kind ON TABLE user TYPE string;
      DEFINE FIELD is_admin ON TABLE user TYPE bool DEFAULT false;
      DEFINE FIELD created_at ON TABLE user TYPE datetime VALUE time::now();
      DEFINE ACCESS member_test ON DATABASE TYPE RECORD
        SIGNIN (
          SELECT * FROM user WHERE email = $email
            AND crypto::argon2::compare(password, $password)
        )
        DURATION FOR SESSION 1h;
      DEFINE ACCESS admin_jwt ON DATABASE TYPE JWT URL ${JSON.stringify(`${issuer}/jwks`)};
      CREATE user:owner CONTENT {
        email: "owner@example.com", subject: "owner-sub",
        kind: "human", is_admin: true
      };
      CREATE user:member CONTENT {
        email: "member@example.com", password: crypto::argon2::generate("member-pass"),
        subject: "member-sub", kind: "human", is_admin: false
      };
      CREATE user:other CONTENT {
        email: "other@example.com", password: crypto::argon2::generate("other-pass"),
        subject: "other-sub", kind: "human", is_admin: false
      };
    `).collect();

    const scripts = await loadTemplateScripts();
    for (const name of ["009-fn-current-user.surql", "032-legal-reference.surql"]) {
      const script = scripts.find((candidate) => candidate.name === name);
      if (!script) throw new Error(`missing workspace migration: ${name}`);
      await root.query(script.sql).collect();
    }
    fixtureCleanup.push(() => { proc.kill(); jwks.stop(true); });
    return { url, namespace, database, issuer, privateKey: keys.privateKey };
  } catch (cause) {
    proc.kill();
    jwks.stop(true);
    throw cause;
  }
}

async function memberSession(fixture: Fixture, email: string, password: string): Promise<Surreal> {
  const db = new Surreal();
  opened.push(db);
  await db.connect(fixture.url, { namespace: fixture.namespace, database: fixture.database });
  await db.signin({
    namespace: fixture.namespace,
    database: fixture.database,
    access: "member_test",
    variables: { email, password },
  });
  return db;
}

async function adminJwtSession(fixture: Fixture, subject: string): Promise<Surreal> {
  const token = await new SignJWT({
    ns: fixture.namespace,
    db: fixture.database,
    ac: "admin_jwt",
    RL: ["Owner"],
  })
    .setSubject(subject)
    .setIssuer(fixture.issuer)
    .setExpirationTime("120s")
    .setIssuedAt()
    .setProtectedHeader({ alg: "ES256", kid: "fixture" })
    .sign(fixture.privateKey);
  const db = new Surreal();
  opened.push(db);
  await db.connect(fixture.url, { namespace: fixture.namespace, database: fixture.database });
  await db.authenticate(token);
  return db;
}

const card = {
  content_public_id: "law-1",
  content_version_id: "content_version:v1",
  title: "测试法规",
  source_url: "https://example.invalid/law",
  locator: "article:1",
  note: "我的批注",
};

describe("legal_reference SurrealDB access contract", () => {
  test("admin JWT 会话与成员 RECORD 会话都能保存引用卡片且归因到本人", async () => {
    const fixture = await setupFixture();
    const admin = await adminJwtSession(fixture, "owner-sub");
    const [adminRows] = await admin
      .query<[Array<{ id: unknown; created_by: unknown }>]>(
        "CREATE legal_reference CONTENT $card RETURN AFTER;",
        { card },
      )
      .collect();
    expect(adminRows).toHaveLength(1);
    expect(String(adminRows[0]?.created_by)).toBe("user:owner");

    const member = await memberSession(fixture, "member@example.com", "member-pass");
    const [memberRows] = await member
      .query<[Array<{ id: unknown; created_by: unknown }>]>(
        "CREATE legal_reference CONTENT $card RETURN AFTER;",
        { card: { ...card, content_public_id: "law-2" } },
      )
      .collect();
    expect(memberRows).toHaveLength(1);
    expect(String(memberRows[0]?.created_by)).toBe("user:member");

    const [spoof] = await member
      .query("CREATE legal_reference CONTENT $card RETURN AFTER;", {
        card: { ...card, content_public_id: "law-3", created_by: new StringRecordId("user:owner") },
      })
      .collect();
    expect(spoof).toEqual([]);

    const other = await memberSession(fixture, "other@example.com", "other-pass");
    const [hijack] = await other
      .query("UPDATE $id SET note = '篡改';", { id: memberRows[0]?.id })
      .collect();
    expect(hijack).toEqual([]);
    const [deleted] = await other
      .query("DELETE $id;", { id: memberRows[0]?.id })
      .collect();
    expect(deleted).toEqual([]);

    const [edited] = await member
      .query<[Array<{ note: unknown }>]>("UPDATE $id SET note = '改批注' RETURN AFTER;", {
        id: memberRows[0]?.id,
      })
      .collect();
    expect(edited[0]?.note).toBe("改批注");
  }, 30_000);
});
