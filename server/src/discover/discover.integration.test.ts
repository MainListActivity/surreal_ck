import { describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { homedir } from "node:os";
import { createDiscoverService } from "./service";
import type { Queryable } from "./service";
import { ensureSystemSchema } from "../db/system-schema";

/**
 * LCA11 真实 SurrealDB 集成测试：起独立内存实例，应用 001-008 内容库 schema，
 * 用真实 content_publisher 会话重建 discover 投影，验证：
 * - 许可含 discover 且生效 → 条目进入投影；许可不含/到期、内容撤回 → 不进入/下架；
 * - 锁定正文唯一标记不进入投影，也不出现在公开查询输出；
 * - 未授权会话读不到 discover 表，写不进去；
 * - discover_event 表拒绝自由文本字段（SCHEMAFULL）。
 */

const PUBLISHER_PASS = crypto.randomUUID() + crypto.randomUUID();

async function spawnSurreal() {
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const surrealBinary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn([surrealBinary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { url: `ws://127.0.0.1:${port}/rpc`, password, proc };
    } catch { /* 等待启动 */ }
    await Bun.sleep(50);
  }
  proc.kill();
  throw new Error("local surrealdb failed to start");
}

function asQueryable(db: Surreal): Queryable {
  return { query: (sql, params) => db.query(sql, params) };
}

describe("LCA11 公开发现投影（真实 SurrealDB）", () => {
  test("投影准入/下架/权限边界/事件结构与公开输出的标记隔离", async () => {
    const { url, password, proc } = await spawnSurreal();
    const root = new Surreal();
    const publisher = new Surreal();
    const stranger = new Surreal();
    const sys = new Surreal();
    try {
      await root.connect(url);
      await root.signin({ username: "test", password });
      await root.query("DEFINE NAMESPACE test; USE NS test; DEFINE DATABASE content; USE DB content;");
      await root.use({ namespace: "test", database: "content" });
      for (const script of await loadPlatformContentScripts()) await root.query(script.sql);
      await root.query(`
        INSERT INTO content_publisher_identity { id: content_publisher_identity:server, active: true };
        INSERT INTO content_publisher_credential { id: content_publisher_credential:server, publisher: content_publisher_identity:server, secret_hash: crypto::argon2::generate($pass) };
      `, { pass: PUBLISHER_PASS });

      await publisher.connect(url, { namespace: "test", database: "content" });
      await publisher.signin({ namespace: "test", database: "content", access: "content_publisher", variables: { pass: PUBLISHER_PASS } });
      const content = asQueryable(publisher);

      // 两份来源：s1 许可含 discover；s2 只许 read（锁定内容，唯一标记）。
      await publisher.query(`
        CREATE content_source:s1 SET source_key='s1', label='公报库', base_url='https://example.invalid', status='active', allowed_actions=['publish','read'];
        CREATE source_license_revision:l1 SET source=content_source:s1, revision=1, license_kind='open', allowed_actions=['discover','browse','search','read'], effective_from=time::now()-1h, created_by_subject='fixture';
        CREATE content_source:s2 SET source_key='s2', label='锁定库', base_url='https://example.invalid', status='active', allowed_actions=['publish'];
        CREATE source_license_revision:l2 SET source=content_source:s2, revision=1, license_kind='locked', allowed_actions=['read'], effective_from=time::now()-1h, created_by_subject='fixture';
        CREATE content_item:i1 SET public_id='i1', kind='legislation', publication_status='published', current_version=content_version:v1;
        CREATE content_version:v1 SET public_id='v1', item=content_item:i1, revision=1, source=content_source:s1, source_url='https://example.invalid/1', fetched_at=time::now(), title='建设工程司法解释（一）', body_text='PUBLIC_OK_BODY', body_sha256='h1', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
        CREATE content_item:i2 SET public_id='i2', kind='judicial_document', publication_status='published', current_version=content_version:v2;
        CREATE content_version:v2 SET public_id='v2', item=content_item:i2, revision=1, source=content_source:s2, source_url='https://example.invalid/2', fetched_at=time::now(), title='LOCKED_MARKER_裁判文书', body_text='LOCKED_MARKER_BODY_SECRET', body_sha256='h2', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
        CREATE content_collection_binding:b1 SET item=content_item:i1, collections=['core_statutes'];
        CREATE content_collection_binding:b2 SET item=content_item:i2, collections=['locked_cases'];
        CREATE content_item:i3 SET public_id='i3', kind='legislation', publication_status='published', current_version=content_version:v3;
        CREATE content_version:v3 SET public_id='v3', item=content_item:i3, revision=1, source=content_source:s1, source_url='https://example.invalid/3', fetched_at=time::now(), title='建设工程合同示范文本', body_text='PUBLIC_OK_BODY_3', body_sha256='h3', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
        CREATE content_collection_binding:b3 SET item=content_item:i3, collections=['qa_gap_pack'];
        CREATE content_search_facet:f3 SET item=content_item:i3, version=content_version:v3, kind='legislation', jurisdiction='CN', published_on='2025-03-01';
        CREATE content_search_facet:f1 SET item=content_item:i1, version=content_version:v1, kind='legislation', jurisdiction='CN', published_on='2025-01-01';
        CREATE content_search_facet:f2 SET item=content_item:i2, version=content_version:v2, kind='judicial_document', jurisdiction='CN', published_on='2025-02-01';
      `);

      // _system 走真实 schema：QA 退回证明 fake 行无法校验 system 侧投影
      //（product_plan 只有 plan_key，旧查询 plan.plan_key 恒 NONE → 建议恒 null）。
      await sys.connect(url);
      await sys.signin({ username: "test", password });
      await sys.use({ namespace: "test", database: "_system" });
      await ensureSystemSchema(sys, { namespace: "test" });
      await sys.query(`
        CREATE content_collection:col_core CONTENT {collection_key:'core_statutes', display_name:'核心法规', status:'active'};
        CREATE content_collection:col_gap CONTENT {collection_key:'qa_gap_pack', display_name:'缺口扩展包', status:'active'};
        CREATE content_template_revision:ctr1 CONTENT {
          collections:[
            {collection:content_collection:col_core, collection_key:'core_statutes', display_name:'核心法规'},
            {collection:content_collection:col_gap, collection_key:'qa_gap_pack', display_name:'缺口扩展包'}
          ],
          actions:['browse'], created_by_subject:'fixture'
        };
        CREATE ai_template_revision:atr1 CONTENT {actions:['research'], created_by_subject:'fixture'};
        CREATE feature_template_revision:ftr1 CONTENT {features:[], created_by_subject:'fixture'};
        CREATE quota_plan:qp1 CONTENT {plan_key:'lawyer_pro', display_name:'Pro', visibility:'public', status:'active'};
        CREATE quota_plan_revision:qpr1 CONTENT {plan:quota_plan:qp1, revision:1, template_kind:'commercial', rules:[], created_by_subject:'fixture', published_at:time::now(), correlation_id:'c1'};
        CREATE product_plan:pp1 CONTENT {plan_key:'lawyer_pro', display_name:'Pro', status:'active', active_revision:product_plan_revision:ppr1};
        CREATE product_plan_revision:ppr1 CONTENT {plan:product_plan:pp1, revision:1, resource_template:quota_plan_revision:qpr1, content_template:content_template_revision:ctr1, ai_template:ai_template_revision:atr1, feature_template:feature_template_revision:ftr1, created_by_subject:'fixture', published_at:time::now(), correlation_id:'c1'};
      `);

      const fakeSystem: Queryable = {
        async query(sql: string, params?: Record<string, unknown>) {
          if (sql.includes("FROM workspace WHERE")) return [[{ id: "workspace:w1", db_name: "ws_acme", status: "active" }]];
          if (sql.includes("FROM user_workspace_index")) return [[{ subject: "alice", disabled_at: null }]];
          if (sql.includes("FROM product_plan")) return sys.query(sql, params);
          if (sql.includes("quota_subscription_item")) return [[null]];
          if (sql.includes("billing_account_member")) return [[]];
          return [[]];
        },
      };
      const service = createDiscoverService({
        content,
        system: fakeSystem,
        entitlementStore: { async currentSnapshot() { return { collections: [{ key: "core_statutes", label: "核心法规" }] }; } },
      });

      // 重建：i1+i3（s1 许可含 discover）入投影；i2 许可不含 discover 不入。
      const rebuilt = await service.rebuildProjection("ops:test", {
        examples: [{ key: "ex1", title: "策划示例", summary: "示例摘要（运营撰写）", citationLabels: ["示例法条"], position: 0 }],
        reason: "initial publish",
      });
      expect(rebuilt).toEqual({ listed: 2, delisted: 0, examples: 1 });

      const projectionRows = await root.query<{ public_id: string; listed: boolean }[]>(
        "SELECT public_id, listed FROM content_discover_item;",
      );
      expect(projectionRows[0]).toContainEqual({ public_id: "i1", listed: true });
      expect(projectionRows[0]).toContainEqual({ public_id: "i3", listed: true });
      // 投影里绝不出现锁定标记（标题/正文都没有进表）。
      expect(JSON.stringify(projectionRows)).not.toContain("LOCKED_MARKER");

      // 公开查询：问题命中 i1+i3；锁定条目与其标记不出现在输出。
      const query = await service.publicQuery("建设工程");
      expect(query.scope.matchedCount).toBe(2);
      expect(query.matchedItems[0]?.publicId).toBe("i1");
      expect(JSON.stringify(query)).not.toContain("LOCKED_MARKER");
      expect(JSON.stringify(query)).not.toContain("SECRET");
      expect(JSON.stringify(query)).not.toContain("body_text");

      // 成员评估：core_statutes 已覆盖、qa_gap_pack 是缺口 → partial；
      // 真实 _system 套餐目录应给出覆盖缺口的单一套餐建议（QA 退回项）。
      const evaluation = await service.evaluateMember({ question: "建设工程", subject: "alice", workspaceDb: "ws_acme" });
      expect(evaluation.coverage).toBe("partial");
      expect(evaluation.gapCollections).toEqual(["qa_gap_pack"]);
      expect(evaluation.suggestion?.planKey).toBe("lawyer_pro");
      expect(evaluation.suggestion?.coversCollections).toEqual(["qa_gap_pack"]);
      expect(evaluation.entry).toEqual({ kind: "request_admin", planKey: "lawyer_pro" });
      expect(JSON.stringify(evaluation)).not.toContain("LOCKED_MARKER");

      // 事件落库：字段全部结构化，无问题原文。
      await service.recordEvent("member", {
        kind: "evaluate", scopeKinds: ["legislation"], scopeCollections: ["core_statutes"],
        planKey: null, moduleKey: null, conversion: "none",
      }, "ws_acme");
      const events = await root.query<{ kind: string; scope_collections: string[] }[]>(
        "SELECT kind, scope_collections FROM discover_event;",
      );
      expect(events[0]).toContainEqual({ kind: "evaluate", scope_collections: ["core_statutes"] });

      // SCHEMAFULL：写入不在 schema 内的自由文本字段直接被引擎拒绝。
      let rejected = false;
      try {
        await publisher.query("INSERT INTO discover_event { kind: 'question', subject_kind: 'visitor', scope_kinds: [], scope_collections: [], conversion: 'none', question_text: '机密案情原文' };");
      } catch { rejected = true; }
      expect(rejected).toBe(true);

      // 权限边界：未认证会话读不到 discover 表、写不进去。
      await stranger.connect(url, { namespace: "test", database: "content" });
      const stolen = JSON.stringify(await stranger.query("SELECT * FROM content_discover_item;"));
      expect(stolen).not.toContain("建设工程司法解释");
      // 未授权 CREATE 被引擎静默拒成空结果；以 root 视角确认没有写入。
      await stranger.query("INSERT INTO content_discover_item { item: content_item:i1, version: content_version:v1, public_id: 'evil', kind: 'legislation', title: 'x', source_key: 'x', source_label: 'x', collections: [], license_revision: source_license_revision:l1 };");
      const rootView = await root.query<{ public_id: string }[]>("SELECT public_id FROM content_discover_item;");
      expect(JSON.stringify(rootView)).not.toContain("evil");
      expect(rootView[0]).toHaveLength(2);

      // 撤回内容 → 重建后 listed=false，不再公开。
      await publisher.query("UPDATE content_item:i1 SET publication_status = 'withdrawn';");
      const second = await service.rebuildProjection("ops:test", { examples: [], reason: "after withdraw" });
      expect(second.listed).toBe(1);
      expect(second.delisted).toBe(1);
      const after = await service.publicQuery("建设工程");
      // i1 下架后只剩 i3 命中。
      expect(after.scope.matchedCount).toBe(1);
      expect(after.matchedItems[0]?.publicId).toBe("i3");
    } finally {
      await sys.close();
      await stranger.close();
      await publisher.close();
      await root.close();
      proc.kill();
      await proc.exited;
    }
  }, 60_000);
});
