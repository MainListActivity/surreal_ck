import { describe, expect, test } from "bun:test";
import { PlatformSecretStore } from "./secret-store";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

type Row = Record<string, unknown>;

/** 内存 Queryable：按 $id 存取行并收集 SQL/参数，用于断言「明文不落盘」。 */
function fakeDb() {
  const rows = new Map<string, Row>();
  const events: Row[] = [];
  const queries: { sql: string; params: Record<string, unknown> }[] = [];
  const db = {
    async query(sql: string, params: Record<string, unknown> = {}) {
      queries.push({ sql, params });
      if (sql.includes("UPSERT")) {
        const id = String(params.id);
        rows.set(id, {
          id,
          name: params.name,
          envelope: params.envelope,
          purpose: params.purpose,
          updated_by: params.actor,
          updated_at: new Date(),
        });
        events.push({
          secret_name: params.name,
          action: params.action,
          actor_subject: params.actor,
          source: params.source,
          detail: params.detail,
        });
        return [[]];
      }
      if (sql.includes("SELECT")) {
        const row = rows.get(String(params.id));
        return [[row].filter(Boolean)];
      }
      return [[]];
    },
  };
  return { db, rows, events, queries };
}

function store(db: ReturnType<typeof fakeDb>["db"], key = KEY_A) {
  return new PlatformSecretStore(key, async () => db);
}

describe("PlatformSecretStore 密封仓", () => {
  test("put → get 往返解封一致；envelope 与事件均不含明文", async () => {
    const f = fakeDb();
    const s = store(f.db);
    await s.put("idp_provision_token", "tok-SECRET-value", { actor: "ops-sub-1", purpose: "test" });
    const got = await s.get("idp_provision_token");
    expect(got?.value).toBe("tok-SECRET-value");
    expect(got?.updatedBy).toBe("ops-sub-1");
    const envelope = f.rows.get("platform_secret:idp_provision_token")?.envelope as string;
    expect(envelope).not.toContain("tok-SECRET-value");
    const parsed = JSON.parse(envelope);
    expect(parsed).toMatchObject({ v: 1, alg: "aes-256-gcm" });
    expect(parsed.iv).toBeString();
    expect(parsed.tag).toBeString();
    expect(parsed.data).toBeString();
    for (const q of f.queries) {
      expect(JSON.stringify(Object.fromEntries(Object.entries(q.params).filter(([k]) => k !== "id")))).not.toContain("tok-SECRET-value");
    }
  });

  test("审计事件记录 actor/action/source，不含明文", async () => {
    const f = fakeDb();
    const s = store(f.db);
    await s.put("idp_provision_token", "tok-hidden", {
      actor: "ops-sub-9",
      action: "rotate",
      source: "ops_api",
      detail: { verifiedAgainst: "GET /admin/tenants" },
    });
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      secret_name: "idp_provision_token",
      action: "rotate",
      actor_subject: "ops-sub-9",
      source: "ops_api",
    });
    expect(JSON.stringify(f.events)).not.toContain("tok-hidden");
  });

  test("错密钥解封 → secret-unseal-failed（fail closed）", async () => {
    const f = fakeDb();
    await store(f.db, KEY_A).put("idp_provision_token", "tok-x", { actor: "a" });
    await expect(store(f.db, KEY_B).get("idp_provision_token")).rejects.toMatchObject({
      code: "secret-unseal-failed",
    });
  });

  test("篡改 envelope → secret-unseal-failed", async () => {
    const f = fakeDb();
    const s = store(f.db);
    await s.put("idp_provision_token", "tok-x", { actor: "a" });
    const row = f.rows.get("platform_secret:idp_provision_token")!;
    const env = JSON.parse(row.envelope as string);
    env.data = env.data.slice(0, -4) + "AAAA";
    row.envelope = JSON.stringify(env);
    await expect(s.get("idp_provision_token")).rejects.toMatchObject({ code: "secret-unseal-failed" });
  });

  test("行不存在 → get/describe 返回 null", async () => {
    const f = fakeDb();
    const s = store(f.db);
    expect(await s.get("idp_provision_token")).toBeNull();
    expect(await s.describe("idp_provision_token")).toBeNull();
  });

  test("再次 put 覆盖为现行值（UPSERT 语义），describe 只读元数据", async () => {
    const f = fakeDb();
    const s = store(f.db);
    await s.put("idp_provision_token", "tok-old", { actor: "a1" });
    await s.put("idp_provision_token", "tok-new", { actor: "a2" });
    expect((await s.get("idp_provision_token"))?.value).toBe("tok-new");
    const meta = await s.describe("idp_provision_token");
    expect(meta).toMatchObject({ name: "idp_provision_token", updatedBy: "a2" });
    expect(f.events).toHaveLength(2);
  });

  test("数据库写入失败 → secret-write-failed（保留底层错误为 cause）", async () => {
    const f = fakeDb();
    const failing = {
      async query() {
        throw new Error("Found field 'detail.verifiedAgainst', but no such field exists");
      },
    };
    const s = store(failing);
    const err = await s.put("idp_provision_token", "tok-x", { actor: "a" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "secret-write-failed" });
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(f.queries).toHaveLength(0);
  });

  test("非法密钥格式 → 构造即抛错", () => {
    expect(() => new PlatformSecretStore("not-hex")).toThrow("PLATFORM_SECRET_KEY");
  });
});
