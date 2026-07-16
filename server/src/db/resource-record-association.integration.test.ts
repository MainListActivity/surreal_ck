import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { StringRecordId, Surreal } from "surrealdb";

const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

function firstRows<T>(result: unknown): T[] {
  if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
  return result[0] as T[];
}

async function openAs(input: {
  url: string;
  namespace: string;
  database: string;
  email: string;
  password: string;
}): Promise<Surreal> {
  const db = new Surreal();
  opened.push(db);
  await db.connect(input.url, { namespace: input.namespace, database: input.database });
  await db.signin({
    namespace: input.namespace,
    database: input.database,
    access: "participant_test",
    variables: { email: input.email, password: input.password },
  });
  return db;
}

describe("OIP-16 资源与业务记录关联", () => {
  localSurrealTest("关联支持双向遍历，并以当前用户归因和管理独立生命周期", async () => {
    const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
    const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
    const database = `resource_record_link_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const root = new Surreal();
    opened.push(root);
    await root.connect(url, {
      authentication: {
        username: process.env.LOCAL_SURREAL_ROOT_USER ?? "root",
        password: process.env.LOCAL_SURREAL_ROOT_PASS ?? "root",
      },
      namespace,
      database,
    });

    await root.query(`
      DEFINE TABLE user SCHEMAFULL PERMISSIONS FULL;
      DEFINE FIELD email ON TABLE user TYPE string;
      DEFINE FIELD password ON TABLE user TYPE string;
      DEFINE FIELD is_admin ON TABLE user TYPE bool DEFAULT false;
      DEFINE ACCESS participant_test ON DATABASE TYPE RECORD
        SIGNIN (
          SELECT * FROM user
          WHERE email = $email
            AND crypto::argon2::compare(password, $password)
        )
        DURATION FOR SESSION 1h;
      DEFINE TABLE ent_claim SCHEMALESS
        PERMISSIONS
          FOR select, create, update, delete WHERE $auth != NONE;
      CREATE user:alice CONTENT {
        email: "alice@example.com",
        password: crypto::argon2::generate("alice-pass"),
        is_admin: false,
      };
      CREATE user:bob CONTENT {
        email: "bob@example.com",
        password: crypto::argon2::generate("bob-pass"),
        is_admin: false,
      };
      CREATE user:admin CONTENT {
        email: "admin@example.com",
        password: crypto::argon2::generate("admin-pass"),
        is_admin: true,
      };
    `).collect();

    const scripts = await loadTemplateScripts();
    for (const name of ["008-resource-library.surql", "017-resource-record-association.surql"]) {
      const script = scripts.find((candidate) => candidate.name === name);
      if (!script) throw new Error(`missing workspace migration: ${name}`);
      await root.query(script.sql).collect();
    }

    await root.query(`
      CREATE resource_item:r1 CONTENT {
        resource_type: "web_article",
        title: "网页判例",
        summary: "判例摘要",
        source_url: "https://example.test/case",
        evidence: [],
        tags: [],
        structured_payload: {},
        quality: "user-confirmed",
        content_hash: "content-1",
        evidence_hash: "evidence-1",
        source_hash: "source-1",
        created_by: user:alice,
      };
      CREATE resource_item:r2 CONTENT {
        resource_type: "generic_note",
        title: "人工摘要",
        summary: "人工整理",
        evidence: [],
        tags: [],
        structured_payload: {},
        quality: "user-confirmed",
        content_hash: "content-2",
        evidence_hash: "evidence-2",
        source_hash: "source-2",
        created_by: user:alice,
      };
      CREATE ent_claim:c1 CONTENT { name: "甲公司" };
      CREATE ent_claim:c2 CONTENT { name: "乙公司" };
    `).collect();

    const alice = await openAs({ url, namespace, database, email: "alice@example.com", password: "alice-pass" });
    const bob = await openAs({ url, namespace, database, email: "bob@example.com", password: "bob-pass" });
    const admin = await openAs({ url, namespace, database, email: "admin@example.com", password: "admin-pass" });

    const created = await alice.query(`
      RELATE $resource1->resource_record_link->$record1;
      RELATE $resource1->resource_record_link->$record2;
      RELATE $resource2->resource_record_link->$record1;
    `, {
      resource1: new StringRecordId("resource_item:r1"),
      resource2: new StringRecordId("resource_item:r2"),
      record1: new StringRecordId("ent_claim:c1"),
      record2: new StringRecordId("ent_claim:c2"),
    }).collect();
    expect(created.flat()).toHaveLength(3);

    const resourceToRecords = await alice.query(`
      SELECT VALUE ->resource_record_link->ent_claim.id FROM ONLY $resource;
    `, { resource: new StringRecordId("resource_item:r1") }).collect();
    expect(firstRows<unknown[]>(resourceToRecords).flat().map(String).sort()).toEqual([
      "ent_claim:c1",
      "ent_claim:c2",
    ]);

    const recordToResources = await alice.query(`
      SELECT VALUE <-resource_record_link<-resource_item.id FROM ONLY $record;
    `, { record: new StringRecordId("ent_claim:c1") }).collect();
    expect(firstRows<unknown[]>(recordToResources).flat().map(String).sort()).toEqual([
      "resource_item:r1",
      "resource_item:r2",
    ]);

    const resourceCards = await alice.query(`
      SELECT
        id AS link_id,
        in.id AS resource_id,
        in.title AS title,
        in.summary AS summary,
        in.source_url AS source_url,
        in.evidence AS evidence,
        created_at
      FROM $record<-resource_record_link
      ORDER BY created_at DESC;
    `, { record: new StringRecordId("ent_claim:c1") }).collect();
    expect(firstRows<{ resource_id: unknown; title: string }>(resourceCards).map((item) => ({
      resourceId: String(item.resource_id),
      title: item.title,
    })).sort((left, right) => left.resourceId.localeCompare(right.resourceId))).toEqual([
      { resourceId: "resource_item:r1", title: "网页判例" },
      { resourceId: "resource_item:r2", title: "人工摘要" },
    ]);

    const links = await alice.query(`
      SELECT id, created_by FROM resource_record_link ORDER BY id;
    `).collect();
    expect(firstRows<{ created_by: unknown }>(links).map((link) => String(link.created_by))).toEqual([
      "user:alice",
      "user:alice",
      "user:alice",
    ]);

    const targetLinkId = String((firstRows<{ id: unknown }>(links)[0]!).id);
    const denied = await bob.query("DELETE $link RETURN BEFORE;", {
      link: new StringRecordId(targetLinkId),
    }).collect();
    expect(firstRows(denied)).toEqual([]);

    const removed = await alice.query("DELETE $link RETURN BEFORE;", {
      link: new StringRecordId(targetLinkId),
    }).collect();
    expect(firstRows(removed)).toHaveLength(1);
    expect(await root.select(new StringRecordId("resource_item:r1"))).not.toBeUndefined();

    await admin.query("DELETE $resource;", {
      resource: new StringRecordId("resource_item:r2"),
    }).collect();
    const dangling = await root.query("SELECT * FROM resource_record_link WHERE in = $resource;", {
      resource: new StringRecordId("resource_item:r2"),
    }).collect();
    expect(firstRows(dangling)).toEqual([]);
  }, 20_000);
});
