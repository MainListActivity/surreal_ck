import { test, expect } from "bun:test";
import { Surreal } from "surrealdb";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { ResearchResourceDraft } from "@surreal-ck/shared";
import { buildResourceEmbeddingText, createEmbeddingProfileKey, type EmbeddingProfile } from "../resources/research-save";
import { retrievePrivateVectorScores } from "./private-retrieval";

/**
 * 私有材料向量检索的真实引擎验证（公司 fork，memory）：
 * - 写侧 embedding_text_hash 必须与 PRIVATE_VECTOR_QUERY 的库侧重算逐字节一致；
 * - 资源文本变更后旧向量被新鲜度过滤（不得返回过期向量）；
 * - 跨 workspace（不同 database）的向量不可见——db 边界即隔离。
 */
const SCHEMA = new URL("../../../shared/sql/workspace-template/008-resource-library.surql", import.meta.url);
const PROFILE: EmbeddingProfile = { provider: "fixture", model: "m", dimensions: 4, version: "v1" };
const PROFILE_KEY = createEmbeddingProfileKey(PROFILE);

const draft = (overrides: Partial<ResearchResourceDraft> = {}): ResearchResourceDraft => ({
  resourceType: "generic_note",
  title: "担保合同审查要点",
  summary: "抵押与保证条款",
  sourceTitle: "内部合规手册",
  evidence: [
    { text: "担保范围条款", capturedAt: "2026-01-01T00:00:00Z", order: 0 },
    { text: "保证期间约定", capturedAt: "2026-01-01T00:00:00Z", order: 1 },
  ],
  tags: ["合规", "担保"],
  structuredPayload: {},
  quality: "user-confirmed",
  ...overrides,
});

async function provision(db: Surreal, database: string): Promise<void> {
  await db.use({ namespace: "test", database });
  await db.query(await readFile(SCHEMA, "utf8"));
  // 008 模板只把 evidence 定义为裸 array，fork 的 SCHEMAFULL 会拒绝带字段的对象元素；
  // 生产写入路径（runResearchSave）依赖对象证据，fixture 按预期语义补元素级定义。
  await db.query("DEFINE FIELD evidence.* ON TABLE resource_item TYPE object FLEXIBLE;");
}

async function seedResource(db: Surreal, id: string, d: ResearchResourceDraft, hashText: string): Promise<void> {
  await db.query(
    `CREATE resource_item:${id} SET resource_type=$type, title=$title, summary=$summary,
      source_title=$sourceTitle, evidence=$evidence, tags=$tags, quality='user-confirmed',
      content_hash='c${id}', evidence_hash='e${id}', source_hash='s${id}', created_by=user:t;
     CREATE resource_embedding SET resource=resource_item:${id}, profile_key=$pk, provider='fixture', model='m',
      dimensions=4, profile_version='v1', embedding_text_hash=$hash, vector=[1, 0, 0, 0], status='indexed';`,
    {
      type: d.resourceType, title: d.title, summary: d.summary, sourceTitle: d.sourceTitle ?? null,
      evidence: d.evidence, tags: d.tags,
      pk: PROFILE_KEY, hash: createHash("sha256").update(hashText, "utf8").digest("hex"),
    },
  );
}

test("私有向量检索：写侧 hash 与库侧重算一致；过期向量与跨库向量不可见", async () => {
  const port = 30000 + Math.floor(Math.random() * 2000);
  const pass = crypto.randomUUID();
  const binary = process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`;
  const proc = Bun.spawn([binary, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "t", "--pass", pass, "memory"], { stdout: "ignore", stderr: "ignore" });
  const db = new Surreal();
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* startup */ }
      await Bun.sleep(50);
    }
    await db.connect(`ws://127.0.0.1:${port}/rpc`);
    await db.signin({ username: "t", password: pass });
    await db.query("DEFINE NAMESPACE test; USE NS test; DEFINE DATABASE wa; DEFINE DATABASE wb;");
    await provision(db, "wa");
    const other = new Surreal();
    try {
      await other.connect(`ws://127.0.0.1:${port}/rpc`);
      await other.signin({ username: "t", password: pass });
      await provision(other, "wb");
      // 另一库的同 profile 向量：距离再近也不能串到 wa 的结果里。
      const wbDraft = draft({ title: "wb 私有材料" });
      await seedResource(other, "wb1", wbDraft, buildResourceEmbeddingText(wbDraft));
    } finally { await other.close(); }

    await seedResource(db, "a1", draft(), buildResourceEmbeddingText(draft()));
    // a2：按旧文本落的 hash（模拟资源编辑后未重建索引），向量再近也必须被剔除。
    await seedResource(db, "a2", draft({ title: "已改标题" }), "旧文本-不再匹配");

    const provider = { async embed() { return [1, 0, 0, 0]; } };
    const scores = await retrievePrivateVectorScores({ session: db, profile: PROFILE, query: "担保", provider });
    expect([...scores.keys()].sort()).toEqual(["resource_item:a1"]);
    expect(scores.get("resource_item:a1")).toBeGreaterThan(0.99);

    // a2 的索引 hash 与当前文本重新一致后恢复可见。
    await db.query(`UPDATE resource_embedding SET embedding_text_hash=$h WHERE resource=resource_item:a2;`,
      { h: createHash("sha256").update(buildResourceEmbeddingText(draft({ title: "已改标题" })), "utf8").digest("hex") });
    const after = await retrievePrivateVectorScores({ session: db, profile: PROFILE, query: "担保", provider });
    expect([...after.keys()].sort()).toEqual(["resource_item:a1", "resource_item:a2"]);
  } finally { await db.close(); proc.kill(); await proc.exited; }
}, 60_000);
