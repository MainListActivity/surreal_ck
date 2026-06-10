import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import type { ResearchSaveEvent } from "@surreal-ck/shared";
import { runResearchSave, type EmbeddingProvider } from "./research-save";

type QueryCall = { sql: string; binds: Record<string, unknown> | undefined };

/** 假调用者会话：profile SELECT 与保存事务分开应答，记录所有调用。 */
function fakeSession(options: {
  profile?: Record<string, unknown> | null;
  transactionError?: Error;
} = {}) {
  const calls: QueryCall[] = [];
  const session = {
    async query(sql: string, binds?: Record<string, unknown>) {
      calls.push({ sql, binds });
      if (sql.includes("FROM ONLY workspace_embedding_profile")) {
        return [options.profile ?? null];
      }
      if (options.transactionError) throw options.transactionError;
      return [null];
    },
  } as unknown as Surreal;
  return { session, calls };
}

const profile = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 3,
  version: "v1",
};

const okProvider: EmbeddingProvider = {
  async embed() {
    return [0.1, 0.2, 0.3];
  },
};

function validInput() {
  return {
    sessionId: "research_session:s1",
    draft: {
      title: "合同无效再审案例",
      summary: "再审改判合同无效的关键论证。",
      evidence: [
        {
          text: "最高法院再审认为合同无效。",
          sourceUrl: "https://example.com/case/1",
          sourceTitle: "裁判文书网",
          capturedAt: "2026-06-11T08:00:00.000Z",
          order: 0,
        },
      ],
    },
  };
}

async function collect(generator: AsyncGenerator<ResearchSaveEvent>): Promise<ResearchSaveEvent[]> {
  const events: ResearchSaveEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("runResearchSave", () => {
  test("happy path：validating→embedding→persisting→session-updated→done，事务写入资源 + 向量 + session", async () => {
    const { session, calls } = fakeSession({ profile });

    const events = await collect(
      runResearchSave({ session, embeddingProvider: okProvider }, validInput()),
    );

    expect(events.map((event) => event.kind)).toEqual([
      "validating",
      "embedding",
      "persisting",
      "session-updated",
      "done",
    ]);
    const done = events.at(-1) as Extract<ResearchSaveEvent, { kind: "done" }>;
    expect(done.embeddingStatus).toBe("indexed");
    expect(done.resourceId.startsWith("resource_item:")).toBe(true);

    // 一次 profile 读取 + 一次保存事务，全部走调用者 session
    expect(calls).toHaveLength(2);
    const tx = calls[1];
    expect(tx.sql).toContain("BEGIN TRANSACTION");
    expect(tx.sql).toContain("CREATE ONLY $resource_id CONTENT $resource_content");
    expect(tx.sql).toContain("INSERT INTO resource_embedding");
    expect(tx.sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(tx.sql).toContain("UPDATE ONLY $session_id");

    const content = tx.binds?.resource_content as Record<string, unknown>;
    expect(content.title).toBe("合同无效再审案例");
    expect(content.quality).toBe("user-confirmed");
    expect(typeof content.content_hash).toBe("string");
    expect(typeof content.evidence_hash).toBe("string");
    expect(typeof content.source_hash).toBe("string");

    const embedding = tx.binds?.embedding_content as Record<string, unknown>;
    expect(embedding.vector).toEqual([0.1, 0.2, 0.3]);
    expect(embedding.status).toBe("indexed");
    expect(embedding.dimensions).toBe(3);
    expect(String(embedding.profile_key)).toContain("text-embedding-3-small");
  });

  test("workspace 未配置 embedding profile：embedding=disabled，事务不写 resource_embedding，照常保存", async () => {
    const { session, calls } = fakeSession({ profile: null });

    const events = await collect(runResearchSave({ session }, validInput()));

    expect(events.map((event) => event.kind)).toEqual([
      "validating",
      "embedding",
      "persisting",
      "session-updated",
      "done",
    ]);
    const embedding = events[1] as Extract<ResearchSaveEvent, { kind: "embedding" }>;
    expect(embedding.status).toBe("disabled");
    const done = events.at(-1) as Extract<ResearchSaveEvent, { kind: "done" }>;
    expect(done.embeddingStatus).toBe("disabled");
    expect(calls[1].sql).not.toContain("resource_embedding");
  });

  test("embedding provider 失败：error(stage=embedding)，不发保存事务、无任何重试副作用", async () => {
    const { session, calls } = fakeSession({ profile });
    const failingProvider: EmbeddingProvider = {
      async embed() {
        throw new Error("provider 503");
      },
    };

    const events = await collect(
      runResearchSave({ session, embeddingProvider: failingProvider }, validInput()),
    );

    expect(events.map((event) => event.kind)).toEqual(["validating", "embedding", "error"]);
    const error = events.at(-1) as Extract<ResearchSaveEvent, { kind: "error" }>;
    expect(error.stage).toBe("embedding");
    expect(error.message).toContain("provider 503");
    // 只发生过 profile 读取，没有事务、没有 enqueue/retry 写入
    expect(calls).toHaveLength(1);
  });

  test("research session 不存在或已结束：事务回滚 → error(stage=session-updated)", async () => {
    const { session } = fakeSession({
      profile: null,
      transactionError: new Error('An error occurred: research-session-not-open'),
    });

    const events = await collect(runResearchSave({ session }, validInput()));

    const error = events.at(-1) as Extract<ResearchSaveEvent, { kind: "error" }>;
    expect(error.kind).toBe("error");
    expect(error.stage).toBe("session-updated");
  });

  test("草稿校验失败：error(stage=validating)，完全不触达数据库", async () => {
    const { session, calls } = fakeSession({ profile });
    const input = validInput();
    input.draft.title = "  ";

    const events = await collect(runResearchSave({ session }, input));

    expect(events.map((event) => event.kind)).toEqual(["validating", "error"]);
    const error = events.at(-1) as Extract<ResearchSaveEvent, { kind: "error" }>;
    expect(error.stage).toBe("validating");
    expect(calls).toHaveLength(0);
  });
});
