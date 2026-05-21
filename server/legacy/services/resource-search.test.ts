import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  buildResourceSearchText,
  rankResourceSearchRows,
} from "./resource-search";
import type { ResourceRow } from "./resources";

function resource(input: {
  id: string;
  title: string;
  summary: string;
  quality?: ResourceRow["quality"];
  createdAt?: string;
  tags?: string[];
}): ResourceRow {
  return {
    id: new RecordId("resource_item", input.id),
    workspace: new RecordId("workspace", "demo"),
    resource_type: "generic_note",
    title: input.title,
    summary: input.summary,
    evidence: [],
    tags: input.tags ?? [],
    structured_payload: {},
    quality: input.quality ?? "user-confirmed",
    content_hash: `${input.id}-content`,
    evidence_hash: `${input.id}-evidence`,
    source_hash: `${input.id}-source`,
    created_by: new RecordId("app_user", "u1"),
    created_at: input.createdAt ?? "2026-05-11T07:00:00.000Z",
    updated_at: input.createdAt ?? "2026-05-11T07:00:00.000Z",
  };
}

describe("resource search", () => {
  test("把用户 query 与上下文合成检索文本，并按向量、关键词、质量和新近度排序", () => {
    const highVector = resource({
      id: "r1",
      title: "高相关资源",
      summary: "语义向量最接近。",
      quality: "ai-draft",
      tags: ["合同"],
    });
    const keywordOnly = resource({
      id: "r2",
      title: "合同解除裁判要旨",
      summary: "关键词命中更多。",
      quality: "user-confirmed",
      tags: ["合同"],
    });
    const queryText = buildResourceSearchText({
      query: "争议焦点",
      context: {
        selectedRow: {
          visibleValues: { issue: "合同解除" },
        },
      },
    });

    const ranked = rankResourceSearchRows({
      rows: [keywordOnly, highVector],
      queryText,
      vectorScores: new Map([[String(highVector.id), 0.95]]),
      filters: { tags: ["合同"] },
      now: new Date("2026-05-11T08:00:00.000Z"),
      limit: 2,
      answerThreshold: 0.5,
      candidateThreshold: 0.1,
    });

    expect(queryText).toContain("合同解除");
    expect(ranked.status).toBe("hit");
    expect(ranked.results.map((item) => String(item.row.id))).toEqual([
      String(highVector.id),
      String(keywordOnly.id),
    ]);
    expect(ranked.results[0]?.vectorScore).toBeGreaterThan(ranked.results[1]?.vectorScore ?? 0);
    expect(ranked.results[1]?.keywordScore).toBeGreaterThan(0);
  });
});
